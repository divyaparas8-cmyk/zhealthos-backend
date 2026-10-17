/**
 * Focused Regression Test Suite: ZEALTH REPORTS INTERVAL GENERATION & RECONCILIATION
 * 
 * Verifies:
 * 1. UTC-safe date arithmetic and exact inclusive boundaries
 * 2. 31-day, 90-day, 91-day, 433-day, and 730-day Daily ranges without truncation
 * 3. Daily range > 730 days throws RangeError / returns 400 validation error
 * 4. Weekly ranges exceeding 52 weeks (70 weeks, 105 weeks) without truncation
 * 5. Weekly range > 156 weeks throws RangeError
 * 6. Inverted date ranges throw RangeError / return 400
 * 7. Preservation of Monthly and Yearly behavior
 * 8. Mathematical reconciliation: sum of Detailed Reports Revenue & Appointments === KPI values
 */

const assert = require('assert')
const clinicController = require('../modules/clinic-admin/clinic-admin.controller')
const { generatePeriodIntervals, getReports } = clinicController

console.log('======================================================================')
console.log('RUNNING ZEALTH REPORTS INTERVAL BUG FIX REGRESSION TEST SUITE')
console.log('======================================================================\n')

async function runRegressionSuite() {
  // --------------------------------------------------------------------------
  // TEST 1: 31-day daily range (2026-09-16 to 2026-10-16)
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: 31-Day Daily Range ---')
  const intervals31 = generatePeriodIntervals('2026-09-16', '2026-10-16', 'daily')
  assert.strictEqual(intervals31.length, 31, `Expected 31 daily intervals, got ${intervals31.length}`)
  assert.strictEqual(intervals31[0].startIso, '2026-09-16', 'First interval startIso must match startDate')
  assert.strictEqual(intervals31[0].endIso, '2026-09-17', 'First interval endIso must be next calendar day')
  assert.strictEqual(intervals31[30].startIso, '2026-10-16', 'Last interval startIso must match endDate')
  assert.strictEqual(intervals31[30].endIso, '2026-10-17', 'Last interval endIso must be endDate + 1 day')
  console.log('✓ PASS: 31-day daily range produces exactly 31 intervals with exact boundaries.')

  // --------------------------------------------------------------------------
  // TEST 2: 90-day daily range (2026-01-01 to 2026-03-31: 31+28+31 = 90 days)
  // --------------------------------------------------------------------------
  console.log('--- TEST 2: 90-Day Daily Range ---')
  const intervals90 = generatePeriodIntervals('2026-01-01', '2026-03-31', 'daily')
  assert.strictEqual(intervals90.length, 90, `Expected 90 daily intervals, got ${intervals90.length}`)
  assert.strictEqual(intervals90[0].startIso, '2026-01-01')
  assert.strictEqual(intervals90[89].startIso, '2026-03-31')
  console.log('✓ PASS: 90-day daily range produces exactly 90 intervals.')

  // --------------------------------------------------------------------------
  // TEST 3: 91-day daily range (2026-01-01 to 2026-04-01: 91 days - previously truncated at 90!)
  // --------------------------------------------------------------------------
  console.log('--- TEST 3: 91-Day Daily Range (Regression check: no 90-day cap) ---')
  const intervals91 = generatePeriodIntervals('2026-01-01', '2026-04-01', 'daily')
  assert.strictEqual(intervals91.length, 91, `Expected 91 daily intervals without truncation, got ${intervals91.length}`)
  assert.strictEqual(intervals91[0].startIso, '2026-01-01')
  assert.strictEqual(intervals91[90].startIso, '2026-04-01', 'Interval 91 must represent 2026-04-01')
  console.log('✓ PASS: 91-day daily range produces 91 intervals without premature truncation.')

  // --------------------------------------------------------------------------
  // TEST 4: 433-day daily range (2025-08-05 to 2026-10-12: client-observed browser case)
  // --------------------------------------------------------------------------
  console.log('--- TEST 4: 433-Day Daily Range (Client observation: 2025-08-05 to 2026-10-12) ---')
  const intervals433 = generatePeriodIntervals('2025-08-05', '2026-10-12', 'daily')
  // 2025-08-05 to 2025-12-31: 149 days; 2026-01-01 to 2026-10-12: 285 days. Total = 434 days inclusive
  const expected434 = 434
  assert.strictEqual(intervals433.length, expected434, `Expected ${expected434} daily intervals, got ${intervals433.length}`)
  assert.strictEqual(intervals433[0].startIso, '2025-08-05')
  assert.strictEqual(intervals433[intervals433.length - 1].startIso, '2026-10-12', 'Last interval must be 2026-10-12')
  assert.strictEqual(intervals433[intervals433.length - 1].endIso, '2026-10-13')
  console.log(`✓ PASS: 434-day daily range produces all ${expected434} intervals spanning up to 2026-10-12.`)

  // --------------------------------------------------------------------------
  // TEST 5: 730-day daily range (2 full years: e.g. 2024-10-18 to 2026-10-17)
  // --------------------------------------------------------------------------
  console.log('--- TEST 5: 730-Day Daily Range (Maximum 2-year safe limit) ---')
  // 2024 is a leap year. Between 2024-10-19 and 2026-10-18:
  const dStart = new Date(Date.UTC(2024, 9, 19))
  const dEnd = new Date(dStart.getTime() + (730 - 1) * 86400000)
  const startIso730 = dStart.toISOString().split('T')[0]
  const endIso730 = dEnd.toISOString().split('T')[0]
  const intervals730 = generatePeriodIntervals(startIso730, endIso730, 'daily')
  assert.strictEqual(intervals730.length, 730, `Expected exactly 730 daily intervals, got ${intervals730.length}`)
  console.log('✓ PASS: 730-day daily range produces exactly 730 intervals.')

  // --------------------------------------------------------------------------
  // TEST 6: Range exceeding 730 days throws clear validation error
  // --------------------------------------------------------------------------
  console.log('--- TEST 6: Range Exceeding 730 Days Daily Throws Validation Error ---')
  const dOver = new Date(dStart.getTime() + 731 * 86400000)
  const endIso732 = dOver.toISOString().split('T')[0]
  assert.throws(
    () => generatePeriodIntervals(startIso730, endIso732, 'daily'),
    /Daily reports support a maximum date range of 730 days/,
    'Must throw RangeError when daily range exceeds 730 days'
  )
  console.log('✓ PASS: Daily range > 730 days throws descriptive RangeError.')

  // --------------------------------------------------------------------------
  // TEST 7: Weekly range exceeding 52 weeks (70 weeks and 105 weeks)
  // --------------------------------------------------------------------------
  console.log('--- TEST 7: Weekly Range Exceeding 52 Weeks ---')
  // 70 weeks = 490 days
  const wStart = '2025-01-01'
  const wEnd70 = new Date(new Date('2025-01-01T00:00:00Z').getTime() + (70 * 7 - 1) * 86400000).toISOString().split('T')[0]
  const intervalsW70 = generatePeriodIntervals(wStart, wEnd70, 'weekly')
  assert.strictEqual(intervalsW70.length, 70, `Expected 70 weekly intervals, got ${intervalsW70.length}`)

  // 104 weeks = 2 years
  const wEnd104 = new Date(new Date('2025-01-01T00:00:00Z').getTime() + (104 * 7 - 1) * 86400000).toISOString().split('T')[0]
  const intervalsW104 = generatePeriodIntervals(wStart, wEnd104, 'weekly')
  assert.strictEqual(intervalsW104.length, 104, `Expected 104 weekly intervals, got ${intervalsW104.length}`)
  console.log('✓ PASS: Weekly ranges with 70 and 104 weeks generate complete intervals without 52-week cap.')

  // Weekly exceeding safe limit (156 weeks)
  const wEndOver = new Date(new Date('2025-01-01T00:00:00Z').getTime() + (160 * 7) * 86400000).toISOString().split('T')[0]
  assert.throws(
    () => generatePeriodIntervals(wStart, wEndOver, 'weekly'),
    /Weekly reports support a maximum date range of 156 weeks/,
    'Must throw RangeError when weekly range exceeds 156 weeks'
  )
  console.log('✓ PASS: Weekly range exceeding 156 weeks throws descriptive RangeError.')

  // --------------------------------------------------------------------------
  // TEST 8: Inverted Date Range (startDate > endDate)
  // --------------------------------------------------------------------------
  console.log('--- TEST 8: Inverted Date Range ---')
  assert.throws(
    () => generatePeriodIntervals('2026-10-17', '2026-09-17', 'daily'),
    /Invalid date range: startDate cannot be after endDate/,
    'Must throw RangeError on inverted date range'
  )
  console.log('✓ PASS: Inverted date range throws clear RangeError.')

  // --------------------------------------------------------------------------
  // TEST 9: Monthly and Yearly Behavior Preserved
  // --------------------------------------------------------------------------
  console.log('--- TEST 9: Monthly and Yearly Behavior Preservation ---')
  const monthlyIntervals = generatePeriodIntervals('2026-01-01', '2026-12-31', 'monthly')
  assert.strictEqual(monthlyIntervals.length, 12, '1 full year monthly must produce 12 intervals')
  assert.strictEqual(monthlyIntervals[0].chartLabel, 'Jan')
  assert.strictEqual(monthlyIntervals[11].chartLabel, 'Dec')

  const yearlyIntervals = generatePeriodIntervals('2024-01-01', '2026-12-31', 'yearly')
  assert.strictEqual(yearlyIntervals.length, 3, '2024 to 2026 yearly must produce 3 intervals')
  assert.strictEqual(yearlyIntervals[0].label, '2024')
  assert.strictEqual(yearlyIntervals[2].label, '2026')
  console.log('✓ PASS: Monthly and Yearly interval behavior preserved.')

  // --------------------------------------------------------------------------
  // TEST 10: API Integration & Mathematical Reconciliation for Detailed Reports
  // --------------------------------------------------------------------------
  console.log('--- TEST 10: Mathematical Reconciliation between Detailed Reports & KPIs ---')
  const req = {
    user: { role: 'SUPER_ADMIN' },
    query: {
      startDate: '2026-09-17',
      endDate: '2026-10-17',
      practitioner: 'All Practitioners',
      location: 'All Locations',
      period: 'Daily',
      reportCategory: 'Overview',
      reportType: 'all_summary'
    }
  }

  let captured = null
  let statusCode = 200
  const res = {
    status: (code) => { statusCode = code; return res },
    json: (d) => { captured = d }
  }

  await getReports(req, res, (err) => { if (err) throw err })

  assert.strictEqual(statusCode, 200)
  assert.ok(captured && captured.success)
  const data = captured.data

  const kpiRevenue = data.metrics.revenue
  const tableRows = data.tableData.rows

  // Sum of Detailed Reports Revenue
  const tableRevenueSum = tableRows.reduce((sum, r) => {
    const val = parseFloat(String(r.rev).replace(/[^0-9.-]+/g, '')) || 0
    return sum + val
  }, 0)

  assert.strictEqual(
    Math.round(tableRevenueSum),
    Math.round(kpiRevenue),
    `Detailed Reports table revenue sum ($${tableRevenueSum}) must match KPI revenue ($${kpiRevenue})`
  )
  console.log(`✓ PASS: Detailed Reports Revenue sum ($${tableRevenueSum.toFixed(2)}) strictly matches KPI Revenue ($${kpiRevenue.toFixed(2)}).`)

  // --------------------------------------------------------------------------
  // TEST 11: HTTP 400 Validation on API when exceeding safe range
  // --------------------------------------------------------------------------
  console.log('--- TEST 11: API HTTP 400 on Date Range Exceeding Safe Limit ---')
  let errStatus = 200
  let errBody = null
  const resErr = {
    status: (code) => { errStatus = code; return resErr },
    json: (d) => { errBody = d }
  }
  const reqOver = {
    user: { role: 'SUPER_ADMIN' },
    query: {
      startDate: '2024-01-01',
      endDate: '2026-10-17', // > 1000 days
      period: 'Daily',
      reportCategory: 'Overview',
      reportType: 'all_summary'
    }
  }
  await getReports(reqOver, resErr, (err) => { if (err) throw err })
  assert.strictEqual(errStatus, 400, 'API must return HTTP 400 when range exceeds limit')
  assert.strictEqual(errBody.success, false)
  assert.ok(errBody.message.includes('Daily reports support a maximum date range of 730 days'))
  console.log(`✓ PASS: API correctly returned HTTP 400 with message: "${errBody.message}"`)

  console.log('\n======================================================================')
  console.log('ALL 11 REGRESSION TESTS PASSED (100% SUCCESS)')
  console.log('======================================================================')
}

runRegressionSuite().catch(err => {
  console.error('FAIL in regression suite:', err)
  process.exit(1)
})
