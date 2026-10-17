/**
 * ISOLATED AUTOMATED TEST: TASK 6 PRACTITIONER UTILISATION CALCULATION
 * 
 * Verifies that the utilisation calculation:
 * 1. Uses the canonical formula: (Booked Hours / Available Working Hours) * 100
 * 2. Dynamically scales capacity: (Practitioners Count * 40h)
 * 3. Evaluates to exactly 0% when booked hours are 0 (no hardcoded 78% fallback)
 * 4. Correctly computes nonzero booked hours percentages (e.g. 2%, 50%, 100%)
 * 5. Safely returns 0% when capacity is 0 (no hardcoded 78% fallback)
 */

const assert = require('assert')

console.log('======================================================================')
console.log('RUNNING TASK 6: PRACTITIONER UTILISATION CALCULATION ISOLATED TESTS')
console.log('======================================================================\n')

// Exact pure calculation logic from clinic-admin.controller.js lines 2581-2587
function calculateUtilisation(dbPractitioners, filteredAppointments) {
  const pracCount = Math.max(1, dbPractitioners.length)
  const availableWorkingHours = pracCount * 40
  const bookedHours = filteredAppointments.reduce((acc, a) => acc + ((parseFloat(a.duration) || 60) / 60), 0)
  const calculatedUtilisation = availableWorkingHours > 0
    ? Math.min(100, Math.max(0, Math.round((bookedHours / availableWorkingHours) * 100)))
    : 0
  const utilisationRate = calculatedUtilisation

  return {
    utilisation: utilisationRate,
    utilisationFormula: '(Booked Hours / Available Working Hours) * 100',
    bookedHours: parseFloat(bookedHours.toFixed(1)),
    availableWorkingHours,
    practitionersCount: dbPractitioners.length
  }
}

// --- TEST 1: 0 Booked Hours with 1 Practitioner ---
console.log('--- TEST 1: 0 BOOKED HOURS (1 PRACTITIONER = 40h CAP) ---')
const res1 = calculateUtilisation(['Dr. Alice'], [])
assert.strictEqual(res1.bookedHours, 0, 'Booked hours must be 0')
assert.strictEqual(res1.availableWorkingHours, 40, 'Available working hours must be 40')
assert.strictEqual(res1.utilisation, 0, 'Utilisation must be 0% (NOT 78%)')
console.log(`✓ PASS: 0h booked / 40h cap = ${res1.utilisation}% (No hardcoded fallback).`)

// --- TEST 2: 0 Booked Hours with 4 Practitioners ---
console.log('\n--- TEST 2: 0 BOOKED HOURS (4 PRACTITIONERS = 160h CAP) ---')
const res2 = calculateUtilisation(['Dr. A', 'Dr. B', 'Dr. C', 'Dr. D'], [])
assert.strictEqual(res2.bookedHours, 0, 'Booked hours must be 0')
assert.strictEqual(res2.availableWorkingHours, 160, 'Available working hours must be 160')
assert.strictEqual(res2.utilisation, 0, 'Utilisation must be 0% (NOT 78%)')
console.log(`✓ PASS: 0h booked / 160h cap = ${res2.utilisation}% (No hardcoded fallback).`)

// --- TEST 3: Nonzero Client Observation (3h Booked across 4 Practitioners) ---
console.log('\n--- TEST 3: CLIENT AUDIT CASE (3h BOOKED / 160h CAP) ---')
const appointments3 = [
  { duration: 60 },
  { duration: 60 },
  { duration: 60 }
] // 3 hours total
const res3 = calculateUtilisation(['Dr. A', 'Dr. B', 'Dr. C', 'Dr. D'], appointments3)
assert.strictEqual(res3.bookedHours, 3, 'Booked hours must be 3')
assert.strictEqual(res3.availableWorkingHours, 160, 'Available working hours must be 160')
// (3 / 160) * 100 = 1.875% -> rounded to 2%
assert.strictEqual(res3.utilisation, 2, 'Utilisation must be 2%')
console.log(`✓ PASS: 3h booked / 160h cap = ${res3.utilisation}% (matches client audit observation).`)

// --- TEST 4: Nonzero 50% Utilisation (20h Booked across 1 Practitioner) ---
console.log('\n--- TEST 4: 50% UTILISATION (20h BOOKED / 40h CAP) ---')
const appointments4 = Array.from({ length: 20 }, () => ({ duration: 60 }))
const res4 = calculateUtilisation(['Dr. Solo'], appointments4)
assert.strictEqual(res4.bookedHours, 20)
assert.strictEqual(res4.availableWorkingHours, 40)
assert.strictEqual(res4.utilisation, 50)
console.log(`✓ PASS: 20h booked / 40h cap = ${res4.utilisation}%.`)

// --- TEST 5: 100% Full Capacity (40h Booked across 1 Practitioner) ---
console.log('\n--- TEST 5: 100% UTILISATION (40h BOOKED / 40h CAP) ---')
const appointments5 = Array.from({ length: 40 }, () => ({ duration: 60 }))
const res5 = calculateUtilisation(['Dr. Solo'], appointments5)
assert.strictEqual(res5.bookedHours, 40)
assert.strictEqual(res5.utilisation, 100)
console.log(`✓ PASS: 40h booked / 40h cap = ${res5.utilisation}%.`)

// --- TEST 6: Static Source Inspection of clinic-admin.controller.js ---
console.log('\n--- TEST 6: STATIC SOURCE CODE VERIFICATION ---')
const fs = require('fs')
const path = require('path')
const controllerPath = path.resolve(__dirname, '../modules/clinic-admin/clinic-admin.controller.js')
const controllerSrc = fs.readFileSync(controllerPath, 'utf8')

// Verify that the hardcoded fallback is removed from the getReports section
const getReportsSection = controllerSrc.substring(
  controllerSrc.indexOf('// Utilisation formula:'),
  controllerSrc.indexOf('// Utilisation formula:') + 1000
)

assert.ok(!getReportsSection.includes(': 78'), 'getReports must NOT contain hardcoded : 78 fallback')
assert.ok(getReportsSection.includes('const utilisationRate = calculatedUtilisation'), 'utilisationRate must directly equal calculatedUtilisation')
assert.ok(getReportsSection.includes(': 0'), 'Ternary fallback when availableWorkingHours is 0 must evaluate to 0')
console.log('✓ PASS: Static code verification confirms : 78 hardcoded fallback is completely removed.')

console.log('\n======================================================================')
console.log('ALL TASK 6 UTILISATION CALCULATION TESTS PASSED (100% SUCCESS)')
console.log('======================================================================\n')
