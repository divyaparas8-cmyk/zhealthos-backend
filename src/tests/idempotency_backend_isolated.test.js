/**
 * ISOLATED AUTOMATED TEST SUITE: BACKEND INVOICE IDEMPOTENCY & CONCURRENCY
 * 
 * Verifies with 100% isolated in-memory mocks:
 * 1. Single submission creates exactly one invoice.
 * 2. 5 concurrent requests with the same key create exactly one invoice (4 return idempotent replay).
 * 3. Same key + different payload returns HTTP 409 Conflict.
 * 4. Different keys permit legitimate separate invoices.
 * 5. Network timeout followed by retry does not create a duplicate.
 * 6. Concurrent distinct invoices receive unique sequential numbers via conflict-retry.
 * 7. Tenant isolation: Clinic A and Clinic B using the same key do not collide.
 * 8. Missing clinic/tenant context for keyed request returns HTTP 403.
 * 9. Legacy unkeyed requests remain supported.
 */

const assert = require('assert')
const crypto = require('crypto')

console.log('======================================================================')
console.log('STARTING BACKEND INVOICE IDEMPOTENCY ISOLATED VERIFICATION')
console.log('======================================================================\n')

// In-Memory Database Simulator for Prisma
class MockPrismaDb {
  constructor() {
    this.invoices = []
    this.idempotencies = []
    this.nextInvNum = 30 // Start after existing INV-000030
  }

  reset() {
    this.invoices = []
    this.idempotencies = []
    this.nextInvNum = 30
  }

  // Create a Prisma-like client mock
  getClient() {
    const db = this
    const client = {
      invoice: {
        async findFirst({ where, orderBy, select } = {}) {
          const invList = [...db.invoices].filter(i => i.displayId && i.displayId.startsWith('INV-'))
          if (invList.length === 0) return null
          invList.sort((a, b) => b.displayId.localeCompare(a.displayId))
          const top = invList[0]
          return select ? { displayId: top.displayId } : { ...top }
        },
        async count() {
          return db.invoices.length
        }
      },
      invoiceIdempotency: {
        async findUnique({ where, include } = {}) {
          const idx = where?.clinic_idempotency_key_idx
          if (!idx) return null
          const found = db.idempotencies.find(
            item => item.clinicId === idx.clinicId && item.idempotencyKey === idx.idempotencyKey
          )
          if (!found) return null
          const res = { ...found }
          if (include?.invoice) {
            res.invoice = db.invoices.find(inv => inv.id === found.invoiceId) || null
          }
          return res
        }
      },
      patient: {
        async findFirst() { return null }
      },
      patientClaim: {
        async create({ data }) { return { id: 'clm_' + Date.now(), ...data } }
      },
      async $transaction(fn) {
        // Atomic transaction simulator
        const txInvoices = []
        const txIdemp = []

        const tx = {
          invoice: {
            async create({ data }) {
              // Enforce unique constraint on displayId
              const collision = db.invoices.some(i => i.displayId === data.displayId)
              if (collision) {
                const err = new Error(`Unique constraint failed on the fields: (\`displayId\`)`)
                err.code = 'P2002'
                err.meta = { target: ['displayId'] }
                throw err
              }
              const created = {
                id: 'inv_' + Math.random().toString(36).substring(2, 9),
                createdAt: new Date(),
                ...data
              }
              txInvoices.push(created)
              return created
            }
          },
          invoiceIdempotency: {
            async create({ data }) {
              // Enforce unique constraint on (clinicId, idempotencyKey)
              const collision = db.idempotencies.some(
                i => i.clinicId === data.clinicId && i.idempotencyKey === data.idempotencyKey
              )
              if (collision) {
                const err = new Error(`Unique constraint failed on the fields: (\`clinicId\`, \`idempotencyKey\`)`)
                err.code = 'P2002'
                err.meta = { target: ['clinic_idempotency_key_idx'] }
                throw err
              }
              const created = {
                id: 'idemp_rec_' + Math.random().toString(36).substring(2, 9),
                createdAt: new Date(),
                ...data
              }
              txIdemp.push(created)
              return created
            }
          }
        }

        // Small simulated execution latency to expose race conditions
        await new Promise(r => setTimeout(r, 5 + Math.random() * 10))

        const result = await fn(tx)

        // Atomic commit
        db.invoices.push(...txInvoices)
        db.idempotencies.push(...txIdemp)

        return result
      }
    }
    return client
  }
}

// Intercept require to inject mock Prisma client into clinic-admin.controller
const mockDb = new MockPrismaDb()
const mockPrisma = mockDb.getClient()

const dbPath = require.resolve('../config/db')
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: mockPrisma
}

// Now load clinic-admin.controller with mock Prisma injected
const clinicAdminController = require('../modules/clinic-admin/clinic-admin.controller')

// Helper to simulate Express req, res
function createMockReqRes({ body = {}, headers = {}, clinicId = 'clinic_test_123', email = 'admin@zealth.com' } = {}) {
  const req = {
    body,
    headers,
    user: clinicId ? { id: 'usr_123', clinicId, email } : null
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

async function runAllTests() {
  // ─── TEST 1: Single submission creates exactly one invoice ───────────────────
  console.log('--- TEST 1: SINGLE SUBMISSION CREATES EXACTLY ONE INVOICE ---')
  mockDb.reset()
  const payload1 = {
    clientName: 'Patient Alice',
    practitionerName: 'Dr. Jane Smith',
    amount: 150.00,
    status: 'Processing',
    service: 'Initial Consultation',
    idempotencyKey: 'key_test_001'
  }
  const { req: req1, res: res1, getStatus: getStatus1, getData: getData1 } = createMockReqRes({
    body: payload1,
    headers: { 'x-idempotency-key': 'key_test_001' }
  })

  await clinicAdminController.createInvoice(req1, res1, (e) => { throw e })

  assert.strictEqual(getStatus1(), 200, 'Status must be HTTP 200')
  assert.strictEqual(getData1().success, true, 'Response must indicate success')
  assert.strictEqual(mockDb.invoices.length, 1, 'Exactly 1 invoice in DB')
  assert.strictEqual(mockDb.idempotencies.length, 1, 'Exactly 1 idempotency record in DB')
  assert.strictEqual(mockDb.invoices[0].clientName, 'Patient Alice')
  console.log('✓ PASS Test 1: Single submission created exactly 1 invoice and 1 idempotency record atomically.')

  // ─── TEST 2: Five concurrent requests with same key ─────────────────────────
  console.log('\n--- TEST 2: FIVE CONCURRENT REQUESTS WITH SAME KEY ---')
  mockDb.reset()
  const sameKey = 'key_concurrent_race_999'
  const concurrentPayload = {
    clientName: 'Concurrent Patient',
    practitionerName: 'Dr. John Roe',
    amount: 250.00,
    status: 'Processing',
    service: 'Physiotherapy',
    idempotencyKey: sameKey
  }

  const concurrentRequests = Array.from({ length: 5 }, () =>
    createMockReqRes({
      body: { ...concurrentPayload },
      headers: { 'x-idempotency-key': sameKey }
    })
  )

  const promises = concurrentRequests.map(({ req, res }) =>
    clinicAdminController.createInvoice(req, res, (e) => { throw e })
  )

  await Promise.all(promises)

  assert.strictEqual(mockDb.invoices.length, 1, 'Database must contain exactly 1 invoice despite 5 concurrent requests')
  assert.strictEqual(mockDb.idempotencies.length, 1, 'Database must contain exactly 1 idempotency record')

  const statuses = concurrentRequests.map(r => r.getStatus())
  const all200 = statuses.every(s => s === 200)
  assert.ok(all200, 'All 5 concurrent requests must receive HTTP 200 OK')

  const createdId = mockDb.invoices[0].id
  const allReturnSameInvoice = concurrentRequests.every(r => r.getData().data?.id === createdId)
  assert.ok(allReturnSameInvoice, 'All 5 requests must return the same created invoice ID')

  const replays = concurrentRequests.filter(r => r.getData().idempotentReplay === true)
  assert.strictEqual(replays.length, 4, 'Exactly 4 requests must be identified as idempotent replay')
  console.log(`✓ PASS Test 2: 5 concurrent requests resulted in 1 invoice created, 4 idempotent replays, 0 duplicates.`)

  // ─── TEST 3: Same key + Different payload returns HTTP 409 Conflict ─────────
  console.log('\n--- TEST 3: SAME KEY + DIFFERENT PAYLOAD RETURNS HTTP 409 CONFLICT ---')
  const differentPayload = {
    clientName: 'Different Patient Completely',
    practitionerName: 'Dr. Jane Smith',
    amount: 999.00, // Different amount
    status: 'Processing',
    service: 'Surgery',
    idempotencyKey: sameKey // Reusing same key from Test 2
  }

  const { req: req3, res: res3, getStatus: getStatus3, getData: getData3 } = createMockReqRes({
    body: differentPayload,
    headers: { 'x-idempotency-key': sameKey }
  })

  await clinicAdminController.createInvoice(req3, res3, (e) => { throw e })

  assert.strictEqual(getStatus3(), 409, 'Reusing key with different payload must return HTTP 409')
  assert.strictEqual(getData3().success, false, 'Success must be false on 409')
  assert.ok(getData3().error.includes('previously used with different invoice parameters'), 'Error must explain conflict')
  assert.strictEqual(mockDb.invoices.length, 1, 'No new invoice created on 409')
  console.log('✓ PASS Test 3: HTTP 409 Conflict returned when same key was used with different payload.')

  // ─── TEST 4: Different keys permit legitimate separate invoices ─────────────
  console.log('\n--- TEST 4: DIFFERENT KEYS PERMIT LEGITIMATE SEPARATE INVOICES ---')
  const { req: req4, res: res4, getStatus: getStatus4 } = createMockReqRes({
    body: {
      clientName: 'Patient Alice',
      practitionerName: 'Dr. Jane Smith',
      amount: 150.00,
      status: 'Processing',
      service: 'Follow-up Session',
      idempotencyKey: 'key_legitimate_distinct_002'
    },
    headers: { 'x-idempotency-key': 'key_legitimate_distinct_002' }
  })

  await clinicAdminController.createInvoice(req4, res4, (e) => { throw e })

  assert.strictEqual(getStatus4(), 200, 'Distinct key must succeed')
  assert.strictEqual(mockDb.invoices.length, 2, 'Total invoices in DB must now be 2')
  assert.strictEqual(mockDb.idempotencies.length, 2, 'Total idempotencies in DB must now be 2')
  console.log('✓ PASS Test 4: Legitimate separate invoices with distinct keys succeed without interference.')

  // ─── TEST 5: Network timeout followed by retry does not duplicate ───────────
  console.log('\n--- TEST 5: RETRY AFTER SIMULATED NETWORK TIMEOUT ---')
  const retryKey = 'key_retry_simulation_555'
  const retryPayload = {
    clientName: 'Retry Patient',
    practitionerName: 'Dr. Anne',
    amount: 320.00,
    status: 'Processing',
    service: 'Cardio Rehab',
    idempotencyKey: retryKey
  }

  // Attempt 1: Succeeds in DB, but client experienced network drop before receiving body
  const { req: req5a, res: res5a } = createMockReqRes({
    body: retryPayload,
    headers: { 'x-idempotency-key': retryKey }
  })
  await clinicAdminController.createInvoice(req5a, res5a, (e) => { throw e })
  const invoiceCountAfterAttempt1 = mockDb.invoices.length

  // Attempt 2: Client retries with the SAME key and SAME payload
  const { req: req5b, res: res5b, getStatus: getStatus5b, getData: getData5b } = createMockReqRes({
    body: retryPayload,
    headers: { 'x-idempotency-key': retryKey }
  })
  await clinicAdminController.createInvoice(req5b, res5b, (e) => { throw e })

  assert.strictEqual(getStatus5b(), 200, 'Retry must return HTTP 200')
  assert.strictEqual(getData5b().idempotentReplay, true, 'Retry must be identified as idempotent replay')
  assert.strictEqual(mockDb.invoices.length, invoiceCountAfterAttempt1, 'No duplicate invoice created on retry')
  console.log('✓ PASS Test 5: Client retry after network failure safely returned original invoice with 0 duplicates.')

  // ─── TEST 6: Concurrent distinct invoices receive unique sequential numbers ──
  console.log('\n--- TEST 6: CONCURRENT DISTINCT INVOICES RECEIVE UNIQUE INVOICE NUMBERS ---')
  mockDb.reset()
  const distinctRequests = Array.from({ length: 4 }, (_, i) =>
    createMockReqRes({
      body: {
        clientName: `Distinct Patient ${i + 1}`,
        practitionerName: 'Dr. Jane Smith',
        amount: 100 + i * 10,
        status: 'Processing',
        service: `Service ${i + 1}`,
        idempotencyKey: `distinct_key_${i + 1}`
      },
      headers: { 'x-idempotency-key': `distinct_key_${i + 1}` }
    })
  )

  await Promise.all(
    distinctRequests.map(({ req, res }) => clinicAdminController.createInvoice(req, res, (e) => { throw e }))
  )

  assert.strictEqual(mockDb.invoices.length, 4, 'Must create 4 distinct invoices')
  const displayIds = mockDb.invoices.map(i => i.displayId)
  const uniqueDisplayIds = new Set(displayIds)
  assert.strictEqual(uniqueDisplayIds.size, 4, 'All 4 invoices must have unique displayIds')
  console.log('✓ PASS Test 6: Concurrent distinct invoices received unique display IDs:', displayIds)

  // ─── TEST 7: Tenant isolation (Clinic A vs Clinic B with same key) ──────────
  console.log('\n--- TEST 7: TENANT ISOLATION: CLINIC A AND CLINIC B WITH SAME KEY ---')
  mockDb.reset()
  const sharedKey = 'shared_key_across_tenants_101'
  const payloadClinicA = {
    clientName: 'Clinic A Patient',
    practitionerName: 'Dr. A',
    amount: 110.00,
    status: 'Processing',
    service: 'Consultation A',
    idempotencyKey: sharedKey
  }
  const payloadClinicB = {
    clientName: 'Clinic B Patient',
    practitionerName: 'Dr. B',
    amount: 220.00,
    status: 'Processing',
    service: 'Consultation B',
    idempotencyKey: sharedKey
  }

  const { req: reqClinicA, res: resClinicA, getStatus: getStatusA, getData: getDataA } = createMockReqRes({
    body: payloadClinicA,
    headers: { 'x-idempotency-key': sharedKey },
    clinicId: 'clinic_AAA'
  })
  const { req: reqClinicB, res: resClinicB, getStatus: getStatusB, getData: getDataB } = createMockReqRes({
    body: payloadClinicB,
    headers: { 'x-idempotency-key': sharedKey },
    clinicId: 'clinic_BBB'
  })

  await clinicAdminController.createInvoice(reqClinicA, resClinicA, (e) => { throw e })
  await clinicAdminController.createInvoice(reqClinicB, resClinicB, (e) => { throw e })

  assert.strictEqual(getStatusA(), 200, 'Clinic A request must succeed with HTTP 200')
  assert.strictEqual(getStatusB(), 200, 'Clinic B request must succeed with HTTP 200')
  assert.strictEqual(mockDb.invoices.length, 2, 'Both clinics must have their own separate invoice created')
  assert.strictEqual(mockDb.idempotencies.length, 2, 'Both clinics must have separate idempotency records')

  const idempA = mockDb.idempotencies.find(i => i.clinicId === 'clinic_AAA')
  const idempB = mockDb.idempotencies.find(i => i.clinicId === 'clinic_BBB')
  assert.ok(idempA && idempB, 'Records must be isolated by clinicId')
  assert.notStrictEqual(idempA.invoiceId, idempB.invoiceId, 'Invoices must belong to separate entities')
  console.log('✓ PASS Test 7: Tenant isolation verified. Same key in different clinics never collides or leaks.')

  // ─── TEST 8: Missing tenant context for keyed request returns HTTP 403 ──────
  console.log('\n--- TEST 8: MISSING TENANT CONTEXT FOR KEYED REQUEST RETURNS HTTP 403 ---')
  const { req: reqNoClinic, res: resNoClinic, getStatus: getStatusNoClinic, getData: getDataNoClinic } = createMockReqRes({
    body: {
      clientName: 'Patient No Clinic',
      amount: 100,
      idempotencyKey: 'key_unauthenticated_tenant'
    },
    headers: { 'x-idempotency-key': 'key_unauthenticated_tenant' },
    clinicId: null // No authenticated clinic context!
  })

  await clinicAdminController.createInvoice(reqNoClinic, resNoClinic, (e) => { throw e })

  assert.strictEqual(getStatusNoClinic(), 403, 'Must return HTTP 403 Forbidden')
  assert.strictEqual(getDataNoClinic().success, false)
  assert.ok(getDataNoClinic().error.includes('Tenant context required'))
  console.log('✓ PASS Test 8: Missing clinic context rejected with HTTP 403.')

  // ─── TEST 9: Legacy callers without idempotency key continue to work ────────
  console.log('\n--- TEST 9: LEGACY UNKEYED INVOICE CREATION ---')
  const { req: reqLegacy, res: resLegacy, getStatus: getStatusLegacy, getData: getDataLegacy } = createMockReqRes({
    body: {
      clientName: 'Legacy Caller Patient',
      practitionerName: 'Dr. Jane Smith',
      amount: 180.00,
      status: 'Processing',
      service: 'Legacy Routine Service'
      // No idempotencyKey provided
    },
    headers: {} // No idempotency header
  })

  await clinicAdminController.createInvoice(reqLegacy, resLegacy, (e) => { throw e })

  assert.strictEqual(getStatusLegacy(), 200, 'Legacy unkeyed request must succeed with HTTP 200')
  assert.strictEqual(getDataLegacy().success, true)
  assert.ok(getDataLegacy().data?.displayId, 'Legacy invoice receives a displayId')
  console.log('✓ PASS Test 9: Legacy unkeyed request processed successfully with backward compatibility.')

  console.log('\n======================================================================')
  console.log('ALL 9 BACKEND IDEMPOTENCY & CONCURRENCY TESTS PASSED (100% SUCCESS)')
  console.log('======================================================================\n')
}

runAllTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err)
  process.exit(1)
})
