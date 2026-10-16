/**
 * Focused Automated Test Suite: ZEALTH CLINIC ADMIN REPORTS PERIOD FILTER BUG FIX
 * 
 * Tests:
 * 1. generatePeriodIntervals logic for Daily, Weekly, Monthly, Yearly
 * 2. getReports API responses for Daily, Weekly, Monthly, Yearly
 * 3. KPI preservation across all 4 period selections under the same date range
 * 4. Revenue Trend chart aggregation matching the selected period
 * 5. Detailed Reports (all_summary) interval grouping matching the selected period
 * 6. Total mathematical reconciliation: sum of intervals === total KPI values
 * 7. Frontend ReportsPage.jsx dropdown options and useEffect dependency verification
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')

console.log('======================================================================')
console.log('RUNNING ZEALTH CLINIC ADMIN REPORTS PERIOD FILTER VERIFICATION')
console.log('======================================================================\n')

async function runPeriodTests() {
  const clinicController = require('../modules/clinic-admin/clinic-admin.controller')

  // Sample date range matching client observed range (16 Sep 2026 to 16 Oct 2026: 31 days)
  const startDate = '2026-09-16'
  const endDate = '2026-10-16'

  // ==============================================================================
  // TEST SUITE 1: API RESPONSES & KPI PRESERVATION ACROSS PERIODS
  // ==============================================================================
  console.log('--- TEST SUITE 1: API EXECUTION ACROSS DAILY, WEEKLY, MONTHLY, YEARLY ---')

  const periods = ['Daily', 'Weekly', 'Monthly', 'Yearly']
  const results = {}

  for (const p of periods) {
    const req = {
      user: { role: 'SUPER_ADMIN' },
      query: {
        startDate,
        endDate,
        practitioner: 'All Practitioners',
        location: 'All Locations',
        period: p,
        reportCategory: 'Overview',
        reportType: 'all_summary'
      }
    }

    let capturedData = null
    const res = {
      status: () => res,
      json: (d) => { capturedData = d }
    }

    await clinicController.getReports(req, res, (err) => {
      if (err) throw err
    })

    assert.ok(capturedData && capturedData.success, `API must return success: true for period ${p}`)
    results[p] = capturedData.data
    console.log(`✓ Fetched reports for period: ${p}`)
  }

  // 1. KPI Preservation: Metrics must remain IDENTICAL across all periods for the same date range
  const baseRevenue = results['Monthly'].metrics.revenue
  const baseOutstanding = results['Monthly'].metrics.outstanding
  const baseAppointments = results['Monthly'].metrics.appointments

  for (const p of periods) {
    const m = results[p].metrics
    assert.strictEqual(
      m.revenue,
      baseRevenue,
      `Revenue KPI for period ${p} ($${m.revenue}) must equal Monthly base ($${baseRevenue})`
    )
    assert.strictEqual(
      m.outstanding,
      baseOutstanding,
      `Outstanding KPI for period ${p} ($${m.outstanding}) must equal Monthly base ($${baseOutstanding})`
    )
    assert.strictEqual(
      m.appointments,
      baseAppointments,
      `Appointments KPI for period ${p} (${m.appointments}) must equal Monthly base (${baseAppointments})`
    )
  }
  console.log(`✓ PASS: Total KPI values preserved across all periods (Revenue: $${baseRevenue}, Outstanding: $${baseOutstanding}, Appointments: ${baseAppointments})\n`)

  // ==============================================================================
  // TEST SUITE 2: REVENUE TREND CHART AGGREGATION
  // ==============================================================================
  console.log('--- TEST SUITE 2: REVENUE TREND CHART INTERVAL AGGREGATION ---')

  // 1. Daily: 31 intervals for 16 Sep - 16 Oct
  assert.strictEqual(results['Daily'].revenueTrend.length, 31, 'Daily revenue trend must produce 31 daily data points')
  // 2. Weekly: 5 intervals (16-22 Sep, 23-29 Sep, 30 Sep-6 Oct, 7-13 Oct, 14-16 Oct)
  assert.strictEqual(results['Weekly'].revenueTrend.length, 5, 'Weekly revenue trend must produce 5 weekly data points')
  // 3. Monthly: 2 intervals (Sep 2026, Oct 2026)
  assert.strictEqual(results['Monthly'].revenueTrend.length, 2, 'Monthly revenue trend must produce 2 monthly data points')
  // 4. Yearly: 1 interval (2026)
  assert.strictEqual(results['Yearly'].revenueTrend.length, 1, 'Yearly revenue trend must produce 1 yearly data point')

  // Reconcile chart point sums with total revenue
  for (const p of periods) {
    const trendSum = results[p].revenueTrend.reduce((sum, pt) => sum + (pt.current || 0), 0)
    assert.strictEqual(
      trendSum,
      baseRevenue,
      `Sum of revenueTrend current points for ${p} ($${trendSum}) must equal total revenue ($${baseRevenue})`
    )
    console.log(`✓ ${p} Revenue Trend points: ${results[p].revenueTrend.length}, sum: $${trendSum}`)
  }
  console.log('✓ PASS: Revenue Trend chart aggregates correctly according to selected period.\n')

  // ==============================================================================
  // TEST SUITE 3: DETAILED REPORTS (all_summary) INTERVAL GROUPING
  // ==============================================================================
  console.log('--- TEST SUITE 3: DETAILED REPORTS (all_summary) ROW GROUPING ---')

  // 1. Daily: 31 table rows
  assert.strictEqual(results['Daily'].tableData.rows.length, 31, 'Daily all_summary must produce 31 table rows')
  // 2. Weekly: 5 table rows
  assert.strictEqual(results['Weekly'].tableData.rows.length, 5, 'Weekly all_summary must produce 5 table rows')
  // 3. Monthly: 2 table rows
  assert.strictEqual(results['Monthly'].tableData.rows.length, 2, 'Monthly all_summary must produce 2 table rows')
  // 4. Yearly: 1 table row
  assert.strictEqual(results['Yearly'].tableData.rows.length, 1, 'Yearly all_summary must produce 1 table row')

  // Reconcile table row revenue and outstanding sums
  for (const p of periods) {
    const rows = results[p].tableData.rows
    const tableRevSum = rows.reduce((sum, r) => {
      const num = parseFloat(String(r.rev).replace(/[^0-9.-]+/g, '')) || 0
      return sum + num
    }, 0)
    const tableOutSum = rows.reduce((sum, r) => {
      const num = parseFloat(String(r.out).replace(/[^0-9.-]+/g, '')) || 0
      return sum + num
    }, 0)

    assert.strictEqual(
      Math.round(tableRevSum),
      Math.round(baseRevenue),
      `Sum of table row revenues for ${p} ($${tableRevSum}) must equal total revenue ($${baseRevenue})`
    )
    assert.strictEqual(
      Math.round(tableOutSum),
      Math.round(baseOutstanding),
      `Sum of table row outstanding for ${p} ($${tableOutSum}) must equal total outstanding ($${baseOutstanding})`
    )
    console.log(`✓ ${p} Detailed Report rows: ${rows.length}, row rev sum: $${tableRevSum.toFixed(2)}, row out sum: $${tableOutSum.toFixed(2)}`)
  }
  console.log('✓ PASS: Detailed Reports table groups rows dynamically according to selected period.\n')

  // ==============================================================================
  // TEST SUITE 4: FRONTEND DROPDOWN & REACT STATE VERIFICATION
  // ==============================================================================
  console.log('--- TEST SUITE 4: FRONTEND ReportsPage.jsx VERIFICATION ---')

  const reportsPagePath = path.resolve(__dirname, '../../../Zealth-clinic/src/features/reports/pages/ReportsPage.jsx')
  const reportsPageSrc = fs.readFileSync(reportsPagePath, 'utf8')

  // 1. Verify all 4 period options exist in Select dropdown
  assert.ok(reportsPageSrc.includes('<Option value="Daily">Daily</Option>'), 'Must have Daily option')
  assert.ok(reportsPageSrc.includes('<Option value="Weekly">Weekly</Option>'), 'Must have Weekly option')
  assert.ok(reportsPageSrc.includes('<Option value="Monthly">Monthly</Option>'), 'Must have Monthly option')
  assert.ok(reportsPageSrc.includes('<Option value="Yearly">Yearly</Option>'), 'Must have Yearly option')

  // 2. Verify period is passed in getReports parameters
  assert.ok(reportsPageSrc.includes('period,'), 'period must be passed in getReports params object')

  // 3. Verify useEffect dependency array includes period
  assert.ok(
    reportsPageSrc.includes('[dateRange, period, practitioner, location, reportCategory, specificReport]'),
    'useEffect must trigger on period state change'
  )

  // 4. Verify chart label badge reflects period
  assert.ok(reportsPageSrc.includes('{period} View'), 'Chart badge must display {period} View')

  console.log('✓ PASS: Frontend state, dropdown options, and useEffect dependencies verified.\n')

  console.log('======================================================================')
  console.log('ALL 4 PERIOD FILTER VERIFICATION TEST SUITES PASSED (100% SUCCESS)')
  console.log('======================================================================')

  process.exit(0)
}

runPeriodTests().catch(err => {
  console.error('Fatal error in period tests:', err)
  process.exit(1)
})
