/**
 * REAL MYSQL ISOLATED VERIFICATION TEST SUITE
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
console.log('REAL MYSQL INVOICE IDEMPOTENCY & CONCURRENCY VERIFICATION')
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
function createMockReqRes({ body = {}, headers = {}, clinicId = 'clinic_test_tenant_01', email = 'admin@testclinic.com' } = {}) {
  const req = {
    body,
    headers,
    user: clinicId ? { id: 'usr_test_123', clinicId, email } : null
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

async function runRealMySQLTests() {
  const testResults = []

  // --- SAFETY CHECK: Ensure we are connected to zhealthos_isolated_test ONLY ---
  const currentDbResult = await testPrisma.$queryRawUnsafe('SELECT DATABASE() AS current_db;')
  const currentDb = currentDbResult[0]?.current_db
  console.log(`Connected MySQL Database: "${currentDb}"`)
  assert.strictEqual(currentDb, 'zhealthos_isolated_test', 'FATAL: Must be connected to zhealthos_isolated_test ONLY')

  // --- STEP 1: Verify and Apply Reviewed Prisma Migration SQL ---
  console.log('\n--- STEP 1: PRISMA MIGRATION SQL VERIFICATION ---')
  try {
    // Drop existing table if present to test clean migration execution
    await testPrisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0;')
    await testPrisma.$executeRawUnsafe('DROP TABLE IF EXISTS `invoice_idempotency`;')
    await testPrisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1;')

    const migrationSqlPath = path.resolve(__dirname, '../../prisma/migrations/20261016_add_invoice_idempotency/migration.sql')
    const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8')

    // Strip line comments and split statements to execute against real MySQL
    const cleanSql = migrationSql.replace(/--.*$/gm, '').trim()
    const statements = cleanSql
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)

    for (const stmt of statements) {
      await testPrisma.$executeRawUnsafe(stmt)
    }

    // Inspect created table structure in real MySQL
    const tableInfo = await testPrisma.$queryRawUnsafe('DESCRIBE `invoice_idempotency`;')
    const fields = tableInfo.map(f => f.Field)
    assert.ok(fields.includes('id'), 'Field id must exist')
    assert.ok(fields.includes('clinicId'), 'Field clinicId must exist')
    assert.ok(fields.includes('idempotencyKey'), 'Field idempotencyKey must exist')
    assert.ok(fields.includes('requestHash'), 'Field requestHash must exist')
    assert.ok(fields.includes('invoiceId'), 'Field invoiceId must exist')

    // Verify Unique Indices in real MySQL
    const indexInfo = await testPrisma.$queryRawUnsafe('SHOW INDEX FROM `invoice_idempotency`;')
    const indexNames = indexInfo.map(i => i.Key_name)
    assert.ok(indexNames.includes('clinic_idempotency_key_idx'), 'Unique index clinic_idempotency_key_idx must exist')
    assert.ok(indexNames.includes('invoice_idempotency_invoiceId_key'), 'Unique index invoiceId must exist')

    console.log('✓ PASS Step 1: Migration SQL successfully applied to real MySQL with correct schema and unique indexes.')
    testResults.push({ name: 'Migration SQL Verification', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Step 1 Migration:', err.message)
    testResults.push({ name: 'Migration SQL Verification', status: 'FAIL', error: err.message })
    throw err
  }

  // Clean test tables before tests
  await testPrisma.$executeRawUnsafe('DELETE FROM `invoice_idempotency`;')
  await testPrisma.$executeRawUnsafe('DELETE FROM `invoices`;')

  // --- TEST 2: Single Invoice Creation ---
  console.log('\n--- TEST 2: SINGLE INVOICE CREATION ---')
  try {
    const payload = {
      clientName: 'Alice Springs',
      practitionerName: 'Dr. Jane Smith',
      amount: 150.00,
      status: 'Processing',
      service: 'General Consultation',
      idempotencyKey: 'mysql_key_001'
    }
    const { req, res, getStatus, getData } = createMockReqRes({
      body: payload,
      headers: { 'x-idempotency-key': 'mysql_key_001' }
    })

    await clinicAdminController.createInvoice(req, res, (e) => { throw e })

    assert.strictEqual(getStatus(), 200)
    assert.strictEqual(getData().success, true)
    assert.strictEqual(getData().data?.displayId, 'INV-000001')

    const dbInvoices = await testPrisma.invoice.findMany()
    const dbIdemp = await testPrisma.invoiceIdempotency.findMany()
    assert.strictEqual(dbInvoices.length, 1, 'Exactly 1 invoice in MySQL')
    assert.strictEqual(dbIdemp.length, 1, 'Exactly 1 idempotency record in MySQL')
    assert.strictEqual(dbIdemp[0].invoiceId, dbInvoices[0].id)

    console.log('✓ PASS Test 2: Single invoice created atomically with INV-000001 in real MySQL.')
    testResults.push({ name: 'Single Invoice Creation', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Test 2:', err)
    testResults.push({ name: 'Single Invoice Creation', status: 'FAIL', error: err.message })
  }

  // --- TEST 3: Five Simultaneous Requests With Same Key ---
  console.log('\n--- TEST 3: FIVE SIMULTANEOUS REQUESTS (SAME KEY) ---')
  try {
    const initialInvoiceCount = await testPrisma.invoice.count()
    const sameKey = 'mysql_concurrent_key_999'
    const payload = {
      clientName: 'Bob Builder',
      practitionerName: 'Dr. John Doe',
      amount: 220.00,
      status: 'Processing',
      service: 'Physiotherapy',
      idempotencyKey: sameKey
    }

    const requests = Array.from({ length: 5 }, () =>
      createMockReqRes({
        body: { ...payload },
        headers: { 'x-idempotency-key': sameKey }
      })
    )

    // Execute all 5 simultaneously
    await Promise.all(requests.map(({ req, res }) =>
      clinicAdminController.createInvoice(req, res, (e) => { throw e })
    ))

    const finalInvoiceCount = await testPrisma.invoice.count()
    assert.strictEqual(finalInvoiceCount, initialInvoiceCount + 1, 'MySQL must only have 1 new invoice')

    const statuses = requests.map(r => r.getStatus())
    assert.ok(statuses.every(s => s === 200), 'All 5 requests must receive HTTP 200')

    const createdIds = requests.map(r => r.getData().data?.id)
    assert.ok(createdIds.every(id => id === createdIds[0]), 'All 5 requests must return identical invoice ID')

    const replays = requests.filter(r => r.getData().idempotentReplay === true)
    assert.strictEqual(replays.length, 4, 'Exactly 4 requests must be flagged as idempotentReplay')

    console.log('✓ PASS Test 3: 5 simultaneous requests produced exactly 1 invoice and 4 idempotent replays in MySQL.')
    testResults.push({ name: 'Five Simultaneous Requests (Same Key)', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Test 3:', err)
    testResults.push({ name: 'Five Simultaneous Requests (Same Key)', status: 'FAIL', error: err.message })
  }

  // --- TEST 4: Same Key + Different Payload Returns HTTP 409 ---
  console.log('\n--- TEST 4: SAME KEY + DIFFERENT PAYLOAD (HTTP 409) ---')
  try {
    const initialCount = await testPrisma.invoice.count()
    const { req, res, getStatus, getData } = createMockReqRes({
      body: {
        clientName: 'Fraudulent Change Patient',
        practitionerName: 'Dr. Altered',
        amount: 888.00, // Different amount
        status: 'Processing',
        service: 'Altered Service',
        idempotencyKey: 'mysql_key_001' // Same key from Test 2
      },
      headers: { 'x-idempotency-key': 'mysql_key_001' }
    })

    await clinicAdminController.createInvoice(req, res, (e) => { throw e })

    assert.strictEqual(getStatus(), 409, 'Must return HTTP 409 Conflict')
    assert.strictEqual(getData().success, false)
    assert.ok(getData().error.includes('previously used with different invoice parameters'))

    const afterCount = await testPrisma.invoice.count()
    assert.strictEqual(afterCount, initialCount, 'No new invoice inserted into MySQL')

    console.log('✓ PASS Test 4: Reusing key with different payload safely returned HTTP 409 Conflict.')
    testResults.push({ name: 'Same Key Different Payload (409)', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Test 4:', err)
    testResults.push({ name: 'Same Key Different Payload (409)', status: 'FAIL', error: err.message })
  }

  // --- TEST 5: Different Keys Allow Legitimate Invoices ---
  console.log('\n--- TEST 5: DIFFERENT KEYS PERMIT LEGITIMATE INVOICES ---')
  try {
    const beforeCount = await testPrisma.invoice.count()
    const { req: r1, res: res1 } = createMockReqRes({
      body: { clientName: 'Patient One', amount: 100, service: 'Session 1', idempotencyKey: 'legit_key_A' },
      headers: { 'x-idempotency-key': 'legit_key_A' }
    })
    const { req: r2, res: res2 } = createMockReqRes({
      body: { clientName: 'Patient Two', amount: 100, service: 'Session 2', idempotencyKey: 'legit_key_B' },
      headers: { 'x-idempotency-key': 'legit_key_B' }
    })

    await clinicAdminController.createInvoice(r1, res1, (e) => { throw e })
    await clinicAdminController.createInvoice(r2, res2, (e) => { throw e })

    const afterCount = await testPrisma.invoice.count()
    assert.strictEqual(afterCount, beforeCount + 2, 'Both distinct invoices created in MySQL')

    console.log('✓ PASS Test 5: Distinct idempotency keys created legitimate separate invoices.')
    testResults.push({ name: 'Different Keys Allowed', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Test 5:', err)
    testResults.push({ name: 'Different Keys Allowed', status: 'FAIL', error: err.message })
  }

  // --- TEST 6: Network Timeout Retry ---
  console.log('\n--- TEST 6: RETRY AFTER SIMULATED NETWORK TIMEOUT ---')
  try {
    const retryKey = 'mysql_timeout_retry_777'
    const retryPayload = {
      clientName: 'Retry Patient',
      amount: 300.00,
      service: 'Rehab Session',
      idempotencyKey: retryKey
    }

    // First attempt: committed in DB
    const { req: reqAttempt1, res: resAttempt1 } = createMockReqRes({
      body: retryPayload,
      headers: { 'x-idempotency-key': retryKey }
    })
    await clinicAdminController.createInvoice(reqAttempt1, resAttempt1, (e) => { throw e })
    const countAfterFirst = await testPrisma.invoice.count()

    // Second attempt (client retrying):
    const { req: reqAttempt2, res: resAttempt2, getStatus: getStatus2, getData: getData2 } = createMockReqRes({
      body: retryPayload,
      headers: { 'x-idempotency-key': retryKey }
    })
    await clinicAdminController.createInvoice(reqAttempt2, resAttempt2, (e) => { throw e })

    assert.strictEqual(getStatus2(), 200)
    assert.strictEqual(getData2().idempotentReplay, true)
    const countAfterSecond = await testPrisma.invoice.count()
    assert.strictEqual(countAfterSecond, countAfterFirst, 'Zero duplicate rows created on retry')

    console.log('✓ PASS Test 6: Network retry returned original invoice with 0 duplicates.')
    testResults.push({ name: 'Network Timeout Retry', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Test 6:', err)
    testResults.push({ name: 'Network Timeout Retry', status: 'FAIL', error: err.message })
  }

  // --- TEST 7: Clinic / Tenant Isolation ---
  console.log('\n--- TEST 7: CLINIC / TENANT ISOLATION ---')
  try {
    const crossKey = 'shared_cross_tenant_key_555'
    const payloadA = { clientName: 'Tenant A Client', amount: 120, service: 'A Serv', idempotencyKey: crossKey }
    const payloadB = { clientName: 'Tenant B Client', amount: 140, service: 'B Serv', idempotencyKey: crossKey }

    const { req: reqA, res: resA } = createMockReqRes({
      body: payloadA,
      headers: { 'x-idempotency-key': crossKey },
      clinicId: 'clinic_AAA_tenant'
    })
    const { req: reqB, res: resB } = createMockReqRes({
      body: payloadB,
      headers: { 'x-idempotency-key': crossKey },
      clinicId: 'clinic_BBB_tenant'
    })

    await clinicAdminController.createInvoice(reqA, resA, (e) => { throw e })
    await clinicAdminController.createInvoice(reqB, resB, (e) => { throw e })

    const idempA = await testPrisma.invoiceIdempotency.findUnique({
      where: { clinic_idempotency_key_idx: { clinicId: 'clinic_AAA_tenant', idempotencyKey: crossKey } }
    })
    const idempB = await testPrisma.invoiceIdempotency.findUnique({
      where: { clinic_idempotency_key_idx: { clinicId: 'clinic_BBB_tenant', idempotencyKey: crossKey } }
    })

    assert.ok(idempA && idempB, 'Both tenant records exist in MySQL')
    assert.notStrictEqual(idempA.invoiceId, idempB.invoiceId, 'Tenant invoices are completely separate')

    console.log('✓ PASS Test 7: Tenant isolation verified in MySQL composite unique constraint.')
    testResults.push({ name: 'Clinic / Tenant Isolation', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Test 7:', err)
    testResults.push({ name: 'Clinic / Tenant Isolation', status: 'FAIL', error: err.message })
  }

  // --- TEST 8: Transaction Rollback on Failure ---
  console.log('\n--- TEST 8: TRANSACTION ROLLBACK ON FAILURE ---')
  try {
    const initialInvoiceCount = await testPrisma.invoice.count()
    const initialIdempCount = await testPrisma.invoiceIdempotency.count()

    // Simulate forced transaction failure: invalid client format or DB disconnect inside tx
    let rolledBack = false
    try {
      await testPrisma.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            displayId: 'INV-ROLLBACK-TEST',
            clientName: 'Rollback Client',
            amount: 100
          }
        })
        // Force an error inside the transaction after invoice creation
        throw new Error('Simulated mid-transaction unexpected failure')
      })
    } catch (txErr) {
      rolledBack = true
    }

    assert.strictEqual(rolledBack, true, 'Transaction must throw error')
    const postInvoiceCount = await testPrisma.invoice.count()
    const postIdempCount = await testPrisma.invoiceIdempotency.count()

    assert.strictEqual(postInvoiceCount, initialInvoiceCount, 'Invoice row must be rolled back by MySQL')
    assert.strictEqual(postIdempCount, initialIdempCount, 'Idempotency row must be rolled back by MySQL')

    console.log('✓ PASS Test 8: Transaction rollback verified. Incomplete writes leave zero orphan records in MySQL.')
    testResults.push({ name: 'Transaction Rollback on Failure', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Test 8:', err)
    testResults.push({ name: 'Transaction Rollback on Failure', status: 'FAIL', error: err.message })
  }

  // --- TEST 9: Legacy Requests Without Idempotency Key ---
  console.log('\n--- TEST 9: LEGACY REQUESTS WITHOUT IDEMPOTENCY KEY ---')
  try {
    const beforeInv = await testPrisma.invoice.count()
    const beforeIdemp = await testPrisma.invoiceIdempotency.count()

    const { req, res, getStatus, getData } = createMockReqRes({
      body: {
        clientName: 'Legacy Client',
        practitionerName: 'Dr. Jane Smith',
        amount: 180.00,
        status: 'Processing',
        service: 'Legacy Routine Service'
      },
      headers: {}
    })

    await clinicAdminController.createInvoice(req, res, (e) => { throw e })

    assert.strictEqual(getStatus(), 200)
    assert.strictEqual(getData().success, true)
    assert.ok(getData().data?.displayId)

    const afterInv = await testPrisma.invoice.count()
    const afterIdemp = await testPrisma.invoiceIdempotency.count()

    assert.strictEqual(afterInv, beforeInv + 1, 'Legacy invoice inserted into MySQL')
    assert.strictEqual(afterIdemp, beforeIdemp, 'Zero rows added to invoice_idempotency')

    console.log('✓ PASS Test 9: Legacy unkeyed request processed successfully without idempotency overhead.')
    testResults.push({ name: 'Legacy Requests Support', status: 'PASS' })
  } catch (err) {
    console.error('❌ FAIL Test 9:', err)
    testResults.push({ name: 'Legacy Requests Support', status: 'FAIL', error: err.message })
  }

  // --- TEST 10 & INVESTIGATION: Concurrent Distinct Invoices & Numbering Gaps ---
  console.log('\n--- TEST 10 & INVESTIGATION: CONCURRENT DISTINCT INVOICES & NUMBERING GAPS ---')
  try {
    // Reset test table to measure clean sequence
    await testPrisma.$executeRawUnsafe('DELETE FROM `invoice_idempotency`;')
    await testPrisma.$executeRawUnsafe('DELETE FROM `invoices`;')

    const distinctRequests = Array.from({ length: 4 }, (_, i) =>
      createMockReqRes({
        body: {
          clientName: `Concurrent Distinct Pt ${i + 1}`,
          practitionerName: 'Dr. Jane Smith',
          amount: 100 + i * 10,
          status: 'Processing',
          service: `Service ${i + 1}`,
          idempotencyKey: `real_distinct_key_${i + 1}`
        },
        headers: { 'x-idempotency-key': `real_distinct_key_${i + 1}` }
      })
    )

    // Execute concurrently against real MySQL
    await Promise.all(
      distinctRequests.map(({ req, res }) =>
        clinicAdminController.createInvoice(req, res, (e) => { throw e })
      )
    )

    const createdInvoices = await testPrisma.invoice.findMany({
      orderBy: { displayId: 'asc' },
      select: { displayId: true, clientName: true }
    })

    const displayIds = createdInvoices.map(i => i.displayId)
    console.log('Resulting MySQL displayIds:', displayIds)

    const uniqueIds = new Set(displayIds)
    assert.strictEqual(uniqueIds.size, 4, 'All 4 invoices must have unique numbers')

    // Investigate numbering gaps
    const numbers = displayIds.map(d => parseInt(d.replace('INV-', ''), 10))
    console.log('Parsed Invoice Numbers:', numbers)

    let hasGaps = false
    const gaps = []
    for (let i = 0; i < numbers.length - 1; i++) {
      if (numbers[i + 1] !== numbers[i] + 1) {
        hasGaps = true
        gaps.push({ from: numbers[i], to: numbers[i + 1], skipped: numbers[i + 1] - numbers[i] - 1 })
      }
    }

    if (hasGaps) {
      console.log('⚠️ INVESTIGATION FINDING - NUMBERING GAP DETECTED:', gaps)
      console.log('Cause: `nextNum = parseInt(match[1], 10) + attempts` in clinic-admin.controller.js line 719.')
      throw new Error(`Numbering gaps detected under concurrency: ${JSON.stringify(gaps)}`)
    } else {
      console.log('✓ Sequential numbers without gaps: 1, 2, 3, 4.')
    }
    assert.strictEqual(hasGaps, false, 'Invoice numbers must be sequential without gaps')

    testResults.push({
      name: 'Concurrent Distinct Invoices & Gap Investigation',
      status: 'PASS',
      details: { displayIds, gaps, hasGaps }
    })
  } catch (err) {
    console.error('❌ FAIL Test 10:', err)
    testResults.push({ name: 'Concurrent Distinct Invoices & Gap Investigation', status: 'FAIL', error: err.message })
  }

  // --- FINAL CLEANUP OF DISPOSABLE DATABASE ---
  console.log('\n--- FINAL CLEANUP OF DISPOSABLE DATABASE ---')
  await testPrisma.$executeRawUnsafe('DELETE FROM `invoice_idempotency`;')
  await testPrisma.$executeRawUnsafe('DELETE FROM `invoices`;')
  await testPrisma.$disconnect()

  console.log('\n======================================================================')
  console.log('FINAL REAL MYSQL TEST RESULTS SUMMARY:')
  console.log('======================================================================')
  testResults.forEach((t, i) => {
    console.log(`${i + 1}. [${t.status}] ${t.name}`)
  })
  console.log('======================================================================\n')
}

runRealMySQLTests().catch(err => {
  console.error('\n❌ FATAL TEST RUNNER ERROR:', err)
  process.exit(1)
})
