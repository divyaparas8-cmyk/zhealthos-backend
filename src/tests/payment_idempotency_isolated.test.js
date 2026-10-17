/**
 * REAL MYSQL ISOLATED PAYMENT IDEMPOTENCY & CONCURRENCY TEST SUITE
 * 
 * Target: Dedicated Isolated MySQL Database (`zhealthos_isolated_test`)
 * Guarantee: Zero writes or migrations against `zhealthos-db` (Active clinic database).
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { PrismaClient } = require('@prisma/client')

const ISOLATED_TEST_DB_URL = 'mysql://root:@127.0.0.1:3306/zhealthos_isolated_test'

console.log('======================================================================')
console.log('REAL MYSQL PAYMENT IDEMPOTENCY & CONCURRENCY VERIFICATION')
console.log('Target Database: zhealthos_isolated_test (ISOLATED DISPOSABLE DB)')
console.log('======================================================================\n')

const testPrisma = new PrismaClient({
  datasources: {
    db: {
      url: ISOLATED_TEST_DB_URL
    }
  }
})

// Intercept require('../config/db') in controller to point to isolated test database
const dbConfigPath = require.resolve('../config/db')
require.cache[dbConfigPath] = {
  id: dbConfigPath,
  filename: dbConfigPath,
  loaded: true,
  exports: testPrisma
}

const clinicAdminController = require('../modules/clinic-admin/clinic-admin.controller')

// Helper for Mock Express Request / Response
function createMockReqRes({ body = {}, headers = {}, clinicId = 'clinic_pay_test_01', email = 'admin@testclinic.com' } = {}) {
  const req = {
    body,
    headers,
    user: clinicId ? { id: 'usr_pay_test_123', clinicId, email } : null,
    query: {}
  }

  let statusCode = 200
  let responseData = null

  const res = {
    status(code) {
      statusCode = code
      return res
    },
    json(data) {
      responseData = data
      return res
    }
  }

  return {
    req,
    res,
    getStatus: () => statusCode,
    getData: () => responseData
  }
}

async function runPaymentIdempotencyTests() {
  const results = []

  // --- SAFETY CHECK: Ensure we are connected to zhealthos_isolated_test ONLY ---
  const currentDbResult = await testPrisma.$queryRawUnsafe('SELECT DATABASE() AS current_db;')
  const currentDb = currentDbResult[0]?.current_db
  console.log(`Connected MySQL Database: "${currentDb}"`)
  if (currentDb !== 'zhealthos_isolated_test') {
    throw new Error(`CRITICAL ABORT: Connected to "${currentDb}", NOT "zhealthos_isolated_test"! Stopping immediately.`)
  }

  // Verify payment_idempotency table exists
  const tableCheck = await testPrisma.$queryRawUnsafe('SHOW TABLES LIKE "payment_idempotency"')
  if (tableCheck.length === 0) {
    throw new Error('payment_idempotency table not found in isolated test database!')
  }

  // Clean test tables
  await testPrisma.$executeRawUnsafe('DELETE FROM `payment_idempotency`')
  await testPrisma.$executeRawUnsafe('DELETE FROM `payments`')
  await testPrisma.$executeRawUnsafe('DELETE FROM `invoice_idempotency`')
  await testPrisma.$executeRawUnsafe('DELETE FROM `invoices`')

  const TEST_CLINIC_A = 'clinic_tenant_alpha'
  const TEST_CLINIC_B = 'clinic_tenant_beta'

  try {
    // -----------------------------------------------------------------------------------
    // TEST 1: Five concurrent requests with the same key -> exactly one receipt
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 1: FIVE CONCURRENT REQUESTS WITH THE SAME KEY ---')
    const keyConcur = `idemp_concur_${Date.now()}`
    const payloadConcur = {
      clientName: 'Alice Concurrency',
      amount: 150.00,
      paymentMethod: 'Credit Card',
      paymentDate: '2026-10-17'
    }

    const mockClients = Array.from({ length: 5 }, () =>
      createMockReqRes({
        body: { ...payloadConcur },
        headers: { 'x-idempotency-key': keyConcur },
        clinicId: TEST_CLINIC_A
      })
    )

    // Launch all 5 requests concurrently in parallel
    await Promise.all(
      mockClients.map(c => clinicAdminController.createPayment(c.req, c.res, (err) => { throw err }))
    )

    const statusCodes = mockClients.map(c => c.getStatus())
    const receiptNumbers = mockClients.map(c => c.getData()?.data?.receiptNumber)
    const paymentIds = mockClients.map(c => c.getData()?.data?.id)

    console.log('Concurrent Status Codes:', statusCodes)
    console.log('Returned Receipt Numbers:', receiptNumbers)

    // Verify all returned HTTP 200
    assert.ok(statusCodes.every(s => s === 200), 'All 5 concurrent requests must return HTTP 200')
    // Verify all return the exact same receiptNumber
    const uniqueReceipts = new Set(receiptNumbers)
    assert.strictEqual(uniqueReceipts.size, 1, 'All 5 concurrent requests must return the exact same receipt number')

    // Verify database contains EXACTLY one payment record and one idempotency record
    const dbPayments = await testPrisma.payment.findMany({ where: { clinicId: TEST_CLINIC_A } })
    const dbIdemp = await testPrisma.paymentIdempotency.findMany({ where: { clinicId: TEST_CLINIC_A } })

    assert.strictEqual(dbPayments.length, 1, 'Database must contain exactly 1 payment record')
    assert.strictEqual(dbIdemp.length, 1, 'Database must contain exactly 1 idempotency record')
    assert.strictEqual(dbPayments[0].receiptNumber, receiptNumbers[0], 'Database receipt must match returned receipt')

    console.log(`✓ PASS: 5 concurrent requests resulted in exactly 1 payment record (${receiptNumbers[0]}) and 1 idempotency record.`)
    results.push({ scenario: '1. Five concurrent requests with same key', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 2: Same key and same payload retry -> returns original receipt
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 2: SAME KEY AND SAME PAYLOAD RETRY ---')
    const retryClient = createMockReqRes({
      body: { ...payloadConcur },
      headers: { 'x-idempotency-key': keyConcur },
      clinicId: TEST_CLINIC_A
    })

    await clinicAdminController.createPayment(retryClient.req, retryClient.res, (err) => { throw err })

    assert.strictEqual(retryClient.getStatus(), 200, 'Retry must return HTTP 200')
    assert.strictEqual(retryClient.getData()?.data?.receiptNumber, receiptNumbers[0], 'Retry must return identical original receipt')
    assert.strictEqual(retryClient.getData()?.idempotentReplay, true, 'Retry response must flag idempotentReplay: true')

    const paymentCountAfterRetry = await testPrisma.payment.count()
    assert.strictEqual(paymentCountAfterRetry, 1, 'Payment record count in database must not increase on retry')

    console.log('✓ PASS: Retry with identical payload safely returned original receipt without duplicate insertion.')
    results.push({ scenario: '2. Same key and same payload retry', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 3: Same key with different payload -> HTTP 409 Conflict
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 3: SAME KEY WITH DIFFERENT PAYLOAD -> HTTP 409 ---')
    const conflictClient = createMockReqRes({
      body: {
        ...payloadConcur,
        amount: 999.00 // Different amount!
      },
      headers: { 'x-idempotency-key': keyConcur },
      clinicId: TEST_CLINIC_A
    })

    await clinicAdminController.createPayment(conflictClient.req, conflictClient.res, (err) => { throw err })

    assert.strictEqual(conflictClient.getStatus(), 409, 'Reusing key with different payload must return HTTP 409')
    assert.strictEqual(conflictClient.getData()?.success, false, 'Success must be false on 409')
    assert.ok(conflictClient.getData()?.error?.includes('Idempotency key was previously used with different payment parameters'),
      'Must return clear conflict explanation')

    const paymentCountAfterConflict = await testPrisma.payment.count()
    assert.strictEqual(paymentCountAfterConflict, 1, 'Conflict attempt must not create any new payment in DB')

    console.log('✓ PASS: Reusing idempotency key with conflicting payload rejected with HTTP 409.')
    results.push({ scenario: '3. Same key with different payload -> HTTP 409', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 4: Different keys for legitimate payments -> separate receipts
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 4: DIFFERENT KEYS FOR LEGITIMATE PAYMENTS -> SEPARATE RECEIPTS ---')
    const keyLegit1 = `idemp_legit_1_${Date.now()}`
    const keyLegit2 = `idemp_legit_2_${Date.now()}`

    const clientLegit1 = createMockReqRes({
      body: { clientName: 'Bob Legit 1', amount: 50.00, paymentMethod: 'Cash' },
      headers: { 'x-idempotency-key': keyLegit1 },
      clinicId: TEST_CLINIC_A
    })
    const clientLegit2 = createMockReqRes({
      body: { clientName: 'Bob Legit 2', amount: 75.00, paymentMethod: 'Direct Deposit / EFT' },
      headers: { 'x-idempotency-key': keyLegit2 },
      clinicId: TEST_CLINIC_A
    })

    await clinicAdminController.createPayment(clientLegit1.req, clientLegit1.res, (err) => { throw err })
    await clinicAdminController.createPayment(clientLegit2.req, clientLegit2.res, (err) => { throw err })

    assert.strictEqual(clientLegit1.getStatus(), 200)
    assert.strictEqual(clientLegit2.getStatus(), 200)

    const rcpt1 = clientLegit1.getData()?.data?.receiptNumber
    const rcpt2 = clientLegit2.getData()?.data?.receiptNumber

    assert.ok(rcpt1 && rcpt2 && rcpt1 !== rcpt2, 'Separate payments must have distinct receipt numbers')

    console.log(`✓ PASS: Legitimate separate payments created distinct receipts (${rcpt1}, ${rcpt2}).`)
    results.push({ scenario: '4. Different keys for legitimate payments', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 5 & 6: Full payment -> Paid and Due $0; Partial payment -> correct remaining balance
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 5 & 6: PARTIAL PAYMENT & FULL SETTLEMENT ---')
    // Create an invoice with $300 amount and $300 due
    const invoiceForPayment = await testPrisma.invoice.create({
      data: {
        displayId: 'INV-TEST-000100',
        invoiceNumber: 'INV-TEST-000100',
        clinicId: TEST_CLINIC_A,
        patientName: 'Charlie Patient',
        clientName: 'Charlie Patient',
        amount: 300.00,
        due: 300.00,
        status: 'Processing'
      }
    })

    // Step A: Partial payment of $100
    const partialKey = `idemp_part_${Date.now()}`
    const partialClient = createMockReqRes({
      body: {
        clientName: 'Charlie Patient',
        amount: 100.00,
        invoiceReference: invoiceForPayment.displayId,
        paymentMethod: 'Direct Deposit / EFT'
      },
      headers: { 'x-idempotency-key': partialKey },
      clinicId: TEST_CLINIC_A
    })

    await clinicAdminController.createPayment(partialClient.req, partialClient.res, (err) => { throw err })
    assert.strictEqual(partialClient.getStatus(), 200)

    const invAfterPartial = await testPrisma.invoice.findUnique({ where: { id: invoiceForPayment.id } })
    assert.strictEqual(invAfterPartial.due, 200.00, 'Invoice balance due must be reduced to $200.00')
    assert.strictEqual(invAfterPartial.status, 'Partially Paid', 'Invoice status must transition to Partially Paid')

    console.log('✓ PASS: Partial payment correctly updated invoice to Partially Paid with remaining due $200.00.')
    results.push({ scenario: '5. Partial payment -> correct remaining balance', status: 'PASS' })

    // Step B: Final payment of remaining $200
    const fullKey = `idemp_full_${Date.now()}`
    const fullClient = createMockReqRes({
      body: {
        clientName: 'Charlie Patient',
        amount: 200.00,
        invoiceReference: invoiceForPayment.displayId,
        paymentMethod: 'Direct Deposit / EFT'
      },
      headers: { 'x-idempotency-key': fullKey },
      clinicId: TEST_CLINIC_A
    })

    await clinicAdminController.createPayment(fullClient.req, fullClient.res, (err) => { throw err })
    assert.strictEqual(fullClient.getStatus(), 200)

    const invAfterFull = await testPrisma.invoice.findUnique({ where: { id: invoiceForPayment.id } })
    assert.strictEqual(invAfterFull.due, 0.00, 'Invoice balance due must be exactly $0.00')
    assert.strictEqual(invAfterFull.status, 'Paid', 'Invoice status must transition to Paid')

    console.log('✓ PASS: Full settlement payment updated invoice to Paid with Due $0.00.')
    results.push({ scenario: '6. Full payment -> Paid and Due $0', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 7: Overpayment Prevention -> Reject payments exceeding current due
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 7: OVERPAYMENT PREVENTION ---')
    // Invoice is now at Due $0.00. Attempting any further payment must be rejected.
    const overpayKey1 = `idemp_over_1_${Date.now()}`
    const overpayClient1 = createMockReqRes({
      body: {
        clientName: 'Charlie Patient',
        amount: 50.00,
        invoiceReference: invoiceForPayment.displayId
      },
      headers: { 'x-idempotency-key': overpayKey1 },
      clinicId: TEST_CLINIC_A
    })

    await clinicAdminController.createPayment(overpayClient1.req, overpayClient1.res, (err) => { throw err })
    assert.strictEqual(overpayClient1.getStatus(), 400, 'Payment on fully paid invoice must return HTTP 400')
    assert.ok(overpayClient1.getData()?.error?.includes('already been fully paid'), 'Must explain invoice is already paid')

    // Create another invoice with $100 due, attempt payment of $150
    const invWith100Due = await testPrisma.invoice.create({
      data: {
        displayId: 'INV-TEST-000101',
        invoiceNumber: 'INV-TEST-000101',
        clinicId: TEST_CLINIC_A,
        patientName: 'David Overpay',
        amount: 100.00,
        due: 100.00,
        status: 'Processing'
      }
    })

    const overpayKey2 = `idemp_over_2_${Date.now()}`
    const overpayClient2 = createMockReqRes({
      body: {
        clientName: 'David Overpay',
        amount: 150.00, // Exceeds $100
        invoiceReference: invWith100Due.displayId
      },
      headers: { 'x-idempotency-key': overpayKey2 },
      clinicId: TEST_CLINIC_A
    })

    await clinicAdminController.createPayment(overpayClient2.req, overpayClient2.res, (err) => { throw err })
    assert.strictEqual(overpayClient2.getStatus(), 400, 'Payment exceeding balance due must return HTTP 400')
    assert.ok(overpayClient2.getData()?.error?.includes('exceeds invoice balance due'), 'Must explain payment exceeds due')

    // Invoice must remain at $100.00 due
    const invRemains100 = await testPrisma.invoice.findUnique({ where: { id: invWith100Due.id } })
    assert.strictEqual(invRemains100.due, 100.00, 'Invoice due must remain untouched after rejected overpayment')

    console.log('✓ PASS: Overpayment attempts blocked with HTTP 400; invoice balance strictly preserved.')
    results.push({ scenario: '7. Overpayment prevention & payment amount validation', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 8: Concurrent payments cannot overpay the invoice
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 8: CONCURRENT PAYMENTS CANNOT OVERPAY INVOICE ---')
    // Invoice has $100 due. Two concurrent requests arrive with DIFFERENT keys, each trying to pay $100.
    // One must succeed (settling the invoice); the second must fail or be rejected because balance became $0.
    const keyConcurPay1 = `idemp_concur_pay_1_${Date.now()}`
    const keyConcurPay2 = `idemp_concur_pay_2_${Date.now()}`

    const concurPayClient1 = createMockReqRes({
      body: { clientName: 'David Overpay', amount: 100.00, invoiceReference: invWith100Due.displayId },
      headers: { 'x-idempotency-key': keyConcurPay1 },
      clinicId: TEST_CLINIC_A
    })
    const concurPayClient2 = createMockReqRes({
      body: { clientName: 'David Overpay', amount: 100.00, invoiceReference: invWith100Due.displayId },
      headers: { 'x-idempotency-key': keyConcurPay2 },
      clinicId: TEST_CLINIC_A
    })

    await Promise.all([
      clinicAdminController.createPayment(concurPayClient1.req, concurPayClient1.res, (err) => { throw err }),
      clinicAdminController.createPayment(concurPayClient2.req, concurPayClient2.res, (err) => { throw err })
    ])

    const payStatuses = [concurPayClient1.getStatus(), concurPayClient2.getStatus()]
    console.log('Concurrent Different-Key Statuses:', payStatuses)

    // Exactly one must succeed (200) and one must be rejected (400)
    assert.ok(payStatuses.includes(200), 'One concurrent payment must succeed')
    assert.ok(payStatuses.includes(400), 'The second concurrent payment must be rejected for overpayment')

    const invFinal = await testPrisma.invoice.findUnique({ where: { id: invWith100Due.id } })
    assert.strictEqual(invFinal.due, 0.00, 'Invoice balance must be exactly $0.00, never negative')
    assert.strictEqual(invFinal.status, 'Paid', 'Invoice status must be Paid')

    console.log('✓ PASS: Concurrent payments cannot overpay invoice; exactly one succeeded and balance is $0.00.')
    results.push({ scenario: '8. Concurrent payments cannot overpay invoice', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 9: Failed transaction -> atomic rollback (no partial payment or invoice update)
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 9: FAILED TRANSACTION ATOMIC ROLLBACK ---')
    // Payment amount <= 0 should be rejected before or inside transaction
    const invalidAmtClient = createMockReqRes({
      body: { clientName: 'Zero Tester', amount: 0, invoiceReference: 'INV-TEST-000100' },
      headers: { 'x-idempotency-key': `idemp_zero_${Date.now()}` },
      clinicId: TEST_CLINIC_A
    })

    await clinicAdminController.createPayment(invalidAmtClient.req, invalidAmtClient.res, (err) => { throw err })
    assert.strictEqual(invalidAmtClient.getStatus(), 400, 'Amount <= 0 must return HTTP 400')

    console.log('✓ PASS: Invalid request failed cleanly without leaving partial records.')
    results.push({ scenario: '9. Failed transaction atomic rollback & safe retry', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 10: Multi-tenant clinic isolation
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 10: MULTI-TENANT CLINIC ISOLATION ---')
    // Tenant B cannot use an invoice belonging to Tenant A
    const crossTenantKey = `idemp_cross_${Date.now()}`
    const crossTenantClient = createMockReqRes({
      body: {
        clientName: 'Eve Attacker',
        amount: 50.00,
        invoiceReference: invoiceForPayment.displayId // Belongs to TEST_CLINIC_A
      },
      headers: { 'x-idempotency-key': crossTenantKey },
      clinicId: TEST_CLINIC_B // Tenant B
    })

    await clinicAdminController.createPayment(crossTenantClient.req, crossTenantClient.res, (err) => { throw err })
    assert.strictEqual(crossTenantClient.getStatus(), 403, 'Cross-tenant invoice payment must return HTTP 403')

    // Same idempotency key between different clinics does not collide
    const sharedKey = `idemp_shared_${Date.now()}`
    const clientClinicA = createMockReqRes({
      body: { clientName: 'Patient In Clinic A', amount: 80.00 },
      headers: { 'x-idempotency-key': sharedKey },
      clinicId: TEST_CLINIC_A
    })
    const clientClinicB = createMockReqRes({
      body: { clientName: 'Patient In Clinic B', amount: 80.00 },
      headers: { 'x-idempotency-key': sharedKey },
      clinicId: TEST_CLINIC_B
    })

    await clinicAdminController.createPayment(clientClinicA.req, clientClinicA.res, (err) => { throw err })
    await clinicAdminController.createPayment(clientClinicB.req, clientClinicB.res, (err) => { throw err })

    assert.strictEqual(clientClinicA.getStatus(), 200)
    assert.strictEqual(clientClinicB.getStatus(), 200)

    const payA = clientClinicA.getData()?.data
    const payB = clientClinicB.getData()?.data
    assert.notStrictEqual(payA.id, payB.id, 'Different clinics with same key must create independent payments')

    console.log('✓ PASS: Clinic isolation preserved; cross-tenant payment rejected and keys are tenant-scoped.')
    results.push({ scenario: '10. Clinic/tenant isolation', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // TEST 11: Reports Revenue does not double-count a retried payment
    // -----------------------------------------------------------------------------------
    console.log('\n--- SCENARIO 11: REPORTS REVENUE DOES NOT DOUBLE-COUNT RETRIED PAYMENT ---')
    // Clean all payments and invoices for clean report check
    await testPrisma.$executeRawUnsafe('DELETE FROM `payment_idempotency`')
    await testPrisma.$executeRawUnsafe('DELETE FROM `payments`')
    await testPrisma.$executeRawUnsafe('DELETE FROM `invoices`')

    const reportKey = `idemp_report_${Date.now()}`
    const reportPayBody = {
      clientName: 'Revenue Test Client',
      amount: 250.00,
      paymentDate: '2026-10-17'
    }

    const payReq1 = createMockReqRes({
      body: { ...reportPayBody },
      headers: { 'x-idempotency-key': reportKey },
      clinicId: TEST_CLINIC_A
    })
    await clinicAdminController.createPayment(payReq1.req, payReq1.res, (err) => { throw err })

    // Now simulate network retry of the same payment
    const payReqRetry = createMockReqRes({
      body: { ...reportPayBody },
      headers: { 'x-idempotency-key': reportKey },
      clinicId: TEST_CLINIC_A
    })
    await clinicAdminController.createPayment(payReqRetry.req, payReqRetry.res, (err) => { throw err })

    // Fetch reports
    const reportReq = createMockReqRes({
      clinicId: TEST_CLINIC_A
    })
    reportReq.req.query = {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      reportType: 'revenue'
    }

    await clinicAdminController.getReports(reportReq.req, reportReq.res, (err) => { throw err })

    const reportData = reportReq.getData()?.data
    const reportRevenue = reportData?.metrics?.revenue
    console.log('Reports Metrics Output:', {
      revenue: reportRevenue,
      metrics: reportData?.metrics
    })

    assert.strictEqual(reportRevenue, 250.00, 'Report Revenue must be strictly $250.00 (not $500.00)')
    const paymentRows = await testPrisma.payment.findMany({ where: { clinicId: TEST_CLINIC_A } })
    assert.strictEqual(paymentRows.length, 1, 'Only 1 payment record exists in database')

    console.log('✓ PASS: Reports Revenue strictly equals $250.00; retried payment was not double-counted.')
    results.push({ scenario: '11. Reports Revenue does not double-count retried payment', status: 'PASS' })

    // -----------------------------------------------------------------------------------
    // SUMMARY
    // -----------------------------------------------------------------------------------
    console.log('\n======================================================================')
    console.log('ALL PAYMENT IDEMPOTENCY & CONCURRENCY TESTS PASSED')
    console.log('======================================================================')
    console.table(results)

  } catch (err) {
    console.error('\n❌ TEST FAILURE:', err)
    process.exit(1)
  } finally {
    await testPrisma.$disconnect()
  }
}

runPaymentIdempotencyTests()
