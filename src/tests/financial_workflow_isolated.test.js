/**
 * REAL MYSQL ISOLATED TEST SUITE: FINANCIAL WORKFLOW INTEGRITY & SAFEGUARDS
 * 
 * Target: Dedicated Isolated Disposable MySQL Database (`zhealthos_isolated_test`)
 * Guarantee: Zero writes or migrations against `zhealthos-db` (Active clinic database).
 * 
 * Tests:
 * 1. Direct Paid status bypass rejected via updateInvoice (HTTP 400)
 * 2. Direct Due = $0 bypass rejected via updateInvoice (HTTP 400)
 * 3. Proper Record Payment creates exactly one receipt in payments table
 * 4. Full payment makes invoice Paid and Due $0.00
 * 5. Partial payment updates Due and status correctly to Partially Paid
 * 6. Non-payment fields (line items, dates, sentStatus) update without corrupting partial status/due
 * 7. Reports cash receipts match test payment data
 * 8. Detailed Reports displays payments under the correct calendar dates
 * 9. Linked invoice deletion is blocked when payments exist (HTTP 400)
 * 10. Unlinked draft invoice deletion succeeds (HTTP 200)
 * 11. Duplicate payment submission analysis (Idempotency evaluation)
 */

const assert = require('assert')
const { PrismaClient } = require('@prisma/client')

const ISOLATED_TEST_DB_URL = 'mysql://root:@127.0.0.1:3306/zhealthos_isolated_test'

console.log('======================================================================')
console.log('REAL MYSQL FINANCIAL WORKFLOW & SAFEGUARD VERIFICATION')
console.log('Target Database: zhealthos_isolated_test (ISOLATED DISPOSABLE DB)')
console.log('======================================================================\n')

const testPrisma = new PrismaClient({
  datasources: {
    db: {
      url: ISOLATED_TEST_DB_URL
    }
  }
})

// Intercept require('../config/db') in controller so it operates purely against isolated test db
const dbConfigPath = require.resolve('../config/db')
require.cache[dbConfigPath] = {
  id: dbConfigPath,
  filename: dbConfigPath,
  loaded: true,
  exports: testPrisma
}

const clinicAdminController = require('../modules/clinic-admin/clinic-admin.controller')

// Helper for Mock Express Request / Response
function createMockReqRes({ body = {}, params = {}, query = {}, clinicId = 'clinic_test_safeguard', role = 'CLINIC_ADMIN' } = {}) {
  const req = {
    body,
    params,
    query,
    user: clinicId ? { id: 'usr_test_safe', clinicId, role } : null
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

  return { req, res, getStatus: () => statusCode, getData: () => responseData }
}

async function runFinancialWorkflowSuite() {
  const TEST_CLINIC_ID = 'clinic_test_safeguard'

  // Clean test tables in isolated db before starting
  await testPrisma.payment.deleteMany({ where: { clinicId: TEST_CLINIC_ID } })
  await testPrisma.invoice.deleteMany({ where: { clinicId: TEST_CLINIC_ID } })
  await testPrisma.appointment.deleteMany({ where: { clinicId: TEST_CLINIC_ID } })

  console.log('--- TEST 1: DIRECT "PAID" STATUS BYPASS REJECTED ---')
  // Create an unpaid invoice ($500.00) directly in isolated db
  const inv1 = await testPrisma.invoice.create({
    data: {
      displayId: 'INV-TEST-001',
      invoiceNumber: 'INV-TEST-001',
      clinicId: TEST_CLINIC_ID,
      clientName: 'Safeguard Test Client',
      amount: 500.00,
      due: 500.00,
      status: 'Processing',
      issueDate: '2026-10-16',
      dueDate: '2026-10-23'
    }
  })

  // Attempt to bypass payment allocation by calling updateInvoice with status: 'Paid'
  const mockBypass1 = createMockReqRes({
    params: { id: inv1.id },
    body: { status: 'Paid' },
    clinicId: TEST_CLINIC_ID
  })
  await clinicAdminController.updateInvoice(mockBypass1.req, mockBypass1.res, (err) => { if (err) throw err })

  assert.strictEqual(mockBypass1.getStatus(), 400, 'Direct status change to Paid must be rejected with HTTP 400')
  assert.strictEqual(mockBypass1.getData().success, false)
  assert.ok(
    mockBypass1.getData().message.includes('not permitted without verified payment allocations'),
    `Expected guard message, got: ${mockBypass1.getData().message}`
  )

  // Verify invoice 1 in DB was NOT changed to Paid
  const inv1AfterBypass = await testPrisma.invoice.findUnique({ where: { id: inv1.id } })
  assert.strictEqual(inv1AfterBypass.status, 'Processing')
  assert.strictEqual(Number(inv1AfterBypass.due), 500)
  console.log('✓ PASS: Direct status change to "Paid" rejected with HTTP 400 and invoice remains Processing.')

  console.log('\n--- TEST 2: DIRECT DUE = $0 BYPASS REJECTED ---')
  // Attempt to bypass by submitting due: 0
  const mockBypass2 = createMockReqRes({
    params: { id: inv1.id },
    body: { due: 0 },
    clinicId: TEST_CLINIC_ID
  })
  await clinicAdminController.updateInvoice(mockBypass2.req, mockBypass2.res, (err) => { if (err) throw err })

  assert.strictEqual(mockBypass2.getStatus(), 400, 'Direct due = 0 without payments must be rejected with HTTP 400')
  assert.strictEqual(mockBypass2.getData().success, false)
  console.log('✓ PASS: Direct setting of Balance Due to $0.00 rejected with HTTP 400.')

  console.log('\n--- TEST 3 & 4: PROPER RECORD PAYMENT CREATES RECEIPT & SETTLES INVOICE ---')
  // Execute valid payment recording via createPayment
  const mockPay1 = createMockReqRes({
    body: {
      clientName: 'Safeguard Test Client',
      amount: 500.00,
      paymentDate: '17 Oct 2026',
      paymentMethod: 'Direct Deposit / EFT',
      invoiceReference: inv1.displayId,
      transactionReference: 'tx_safe_full_001'
    },
    clinicId: TEST_CLINIC_ID
  })
  await clinicAdminController.createPayment(mockPay1.req, mockPay1.res, (err) => { if (err) throw err })

  assert.strictEqual(mockPay1.getStatus(), 200, 'createPayment must succeed with HTTP 200')
  const createdPay1 = mockPay1.getData().data
  assert.ok(createdPay1 && createdPay1.receiptNumber, 'Must generate official receiptNumber')
  assert.strictEqual(Number(createdPay1.amount), 500)
  assert.strictEqual(createdPay1.invoiceReference, 'INV-TEST-001')

  // Verify invoice 1 in DB is now legitimately Paid with due $0
  const inv1Settled = await testPrisma.invoice.findUnique({ where: { id: inv1.id } })
  assert.strictEqual(inv1Settled.status, 'Paid', 'Invoice status must be updated to Paid')
  assert.strictEqual(Number(inv1Settled.due), 0.00, 'Invoice due must be 0.00')
  console.log(`✓ PASS: Legitimate payment created receipt ${createdPay1.receiptNumber}; invoice is now Paid with $0.00 due.`)

  console.log('\n--- TEST 5 & 6: PARTIAL PAYMENT ALLOCATION & NON-PAYMENT UPDATES ---')
  // Create second invoice for $300.00
  const inv2 = await testPrisma.invoice.create({
    data: {
      displayId: 'INV-TEST-002',
      invoiceNumber: 'INV-TEST-002',
      clinicId: TEST_CLINIC_ID,
      clientName: 'Partial Test Client',
      amount: 300.00,
      due: 300.00,
      status: 'Processing',
      issueDate: '2026-10-16',
      dueDate: '2026-10-23'
    }
  })

  // Record a partial payment of $100.00
  const mockPay2 = createMockReqRes({
    body: {
      clientName: 'Partial Test Client',
      amount: 100.00,
      paymentDate: '17 Oct 2026',
      paymentMethod: 'Stripe / Credit Card',
      invoiceReference: inv2.displayId,
      transactionReference: 'tx_safe_partial_002'
    },
    clinicId: TEST_CLINIC_ID
  })
  await clinicAdminController.createPayment(mockPay2.req, mockPay2.res, (err) => { if (err) throw err })

  // Verify invoice 2 in DB is Partially Paid with $200.00 due
  const inv2Partial = await testPrisma.invoice.findUnique({ where: { id: inv2.id } })
  assert.strictEqual(inv2Partial.status, 'Partially Paid', 'Invoice status must be Partially Paid')
  assert.strictEqual(Number(inv2Partial.due), 200.00, 'Invoice due must be exactly $200.00')

  // Now test non-payment updates: update sentStatus and client details via updateInvoice
  const mockUpdateSafe = createMockReqRes({
    params: { id: inv2.id },
    body: { sentStatus: 'Sent', service: 'Physiotherapy Assessment' },
    clinicId: TEST_CLINIC_ID
  })
  await clinicAdminController.updateInvoice(mockUpdateSafe.req, mockUpdateSafe.res, (err) => { if (err) throw err })
  assert.strictEqual(mockUpdateSafe.getStatus(), 200)

  // Verify that updating invoice non-payment fields preserves the verified Partially Paid status and $200.00 due
  const inv2Preserved = await testPrisma.invoice.findUnique({ where: { id: inv2.id } })
  assert.strictEqual(inv2Preserved.sentStatus, 'Sent')
  assert.strictEqual(inv2Preserved.status, 'Partially Paid')
  assert.strictEqual(Number(inv2Preserved.due), 200.00)
  console.log('✓ PASS: Partial payment correctly recorded ($100 paid, $200 due); subsequent edits preserve verified status and balance.')

  console.log('\n--- TEST 7 & 8: REPORTS REVENUE & DETAILED REPORTS DATE BUCKETING ---')
  const mockReports = createMockReqRes({
    query: {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      period: 'Daily',
      reportType: 'all_summary'
    },
    clinicId: TEST_CLINIC_ID
  })
  await clinicAdminController.getReports(mockReports.req, mockReports.res, (err) => { if (err) throw err })

  assert.strictEqual(mockReports.getStatus(), 200)
  const reportData = mockReports.getData().data

  // Total cash revenue in reports must equal 500 + 100 = 600
  assert.strictEqual(reportData.metrics.revenue, 600, 'Reports Revenue must match test payment receipts ($600)')

  // Outstanding KPI must match remaining due on active invoices: inv1 (0) + inv2 (200) = 200
  assert.strictEqual(reportData.metrics.outstanding, 200, 'Reports Outstanding must equal remaining unpaid balance ($200)')

  // Detailed Reports table verification: payment must appear under 17 Oct 2026
  const row17Oct = reportData.tableData.rows.find(r => r.period.includes('17 Oct'))
  assert.ok(row17Oct, 'Row for 17 Oct 2026 must exist in Detailed Reports')
  assert.strictEqual(row17Oct.rev, '$600.00', '17 Oct 2026 must display exact combined receipts of $600.00')
  console.log('✓ PASS: Reports Revenue strictly equals $600.00; 17 Oct Detailed Reports correctly displays $600.00 under 17 Oct.')

  console.log('\n--- TEST 9: LINKED INVOICE DELETION IS BLOCKED ---')
  // Attempt to delete inv1 which has a linked payment of $500.00
  const mockDelBlocked = createMockReqRes({
    params: { id: inv1.id },
    clinicId: TEST_CLINIC_ID
  })
  await clinicAdminController.deleteInvoice(mockDelBlocked.req, mockDelBlocked.res, (err) => { if (err) throw err })

  assert.strictEqual(mockDelBlocked.getStatus(), 400, 'Deleting invoice with linked payments must return HTTP 400')
  assert.strictEqual(mockDelBlocked.getData().success, false)
  assert.ok(
    mockDelBlocked.getData().message.includes('1 payment(s) totaling $500.00 AUD are linked to this invoice'),
    `Expected block error message, got: ${mockDelBlocked.getData().message}`
  )

  // Verify inv1 still exists in database
  const inv1StillExists = await testPrisma.invoice.findUnique({ where: { id: inv1.id } })
  assert.ok(inv1StillExists, 'Invoice with linked payments must NOT be deleted')
  console.log('✓ PASS: Deletion of invoice with linked payments is blocked with descriptive HTTP 400.')

  console.log('\n--- TEST 10: UNLINKED DRAFT INVOICE DELETION SUCCEEDS ---')
  // Create an unlinked draft invoice with 0 payments
  const invDraft = await testPrisma.invoice.create({
    data: {
      displayId: 'INV-TEST-DRAFT',
      clinicId: TEST_CLINIC_ID,
      clientName: 'Draft Test Client',
      amount: 150.00,
      due: 150.00,
      status: 'Draft',
      issueDate: '2026-10-16'
    }
  })

  const mockDelDraft = createMockReqRes({
    params: { id: invDraft.id },
    clinicId: TEST_CLINIC_ID
  })
  await clinicAdminController.deleteInvoice(mockDelDraft.req, mockDelDraft.res, (err) => { if (err) throw err })

  assert.strictEqual(mockDelDraft.getStatus(), 200, 'Deleting unlinked invoice must return HTTP 200')
  const invDraftCheck = await testPrisma.invoice.findUnique({ where: { id: invDraft.id } })
  assert.strictEqual(invDraftCheck, null, 'Unlinked draft invoice must be cleanly deleted')
  console.log('✓ PASS: Deletion of unlinked invoice succeeds without restriction.')

  console.log('\n--- TEST 11: PAYMENT SUBMISSION IDEMPOTENCY EVALUATION ---')
  // Evaluate whether payment creation has an idempotency key lock
  // We send two concurrent createPayment requests with identical payload
  const concurrentPayPayload = {
    idempotencyKey: 'concurrent_tx_check_001',
    clientName: 'Idempotency Test Client',
    amount: 50.00,
    paymentDate: '17 Oct 2026',
    paymentMethod: 'Direct Deposit / EFT',
    invoiceReference: inv2.displayId,
    transactionReference: 'concurrent_tx_check_001'
  }

  const mockConc1 = createMockReqRes({ body: concurrentPayPayload, headers: { 'x-idempotency-key': 'concurrent_tx_check_001' }, clinicId: TEST_CLINIC_ID })
  const mockConc2 = createMockReqRes({ body: concurrentPayPayload, headers: { 'x-idempotency-key': 'concurrent_tx_check_001' }, clinicId: TEST_CLINIC_ID })

  await Promise.all([
    clinicAdminController.createPayment(mockConc1.req, mockConc1.res, (err) => { if (err) throw err }),
    clinicAdminController.createPayment(mockConc2.req, mockConc2.res, (err) => { if (err) throw err })
  ])

  const paymentsForTx = await testPrisma.payment.findMany({
    where: { transactionId: 'concurrent_tx_check_001' }
  })

  assert.strictEqual(paymentsForTx.length, 1, 'Payment creation must deduplicate duplicate concurrent requests to exactly 1 receipt')
  console.log(`✓ PASS: Payment idempotency successfully deduplicated request (${paymentsForTx[0].receiptNumber}).`)

  // Cleanup test records from isolated database
  await testPrisma.payment.deleteMany({ where: { clinicId: TEST_CLINIC_ID } })
  await testPrisma.invoice.deleteMany({ where: { clinicId: TEST_CLINIC_ID } })
  await testPrisma.appointment.deleteMany({ where: { clinicId: TEST_CLINIC_ID } })

  console.log('\n======================================================================')
  console.log('ALL 11 FINANCIAL WORKFLOW ISOLATED TESTS COMPLETED (100% SUCCESS)')
  console.log('======================================================================')
}

runFinancialWorkflowSuite()
  .catch(err => {
    console.error('FAIL in financial workflow isolated tests:', err)
    process.exit(1)
  })
  .finally(async () => {
    await testPrisma.$disconnect()
  })
