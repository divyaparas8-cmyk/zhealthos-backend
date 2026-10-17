const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'mysql://root:@127.0.0.1:3306/zhealthos-db'
    }
  }
})

async function runAudit() {
  console.log('======================================================================')
  console.log('READ-ONLY AUDIT: ORIGINAL DATABASE (zhealthos-db)')
  console.log('======================================================================\n')

  try {
    // 1. Database name and version
    const dbNameRes = await prisma.$queryRawUnsafe('SELECT DATABASE() as db')
    const versionRes = await prisma.$queryRawUnsafe('SELECT VERSION() as version')
    console.log(`Database Name: ${dbNameRes[0]?.db}`)
    console.log(`MySQL Version: ${versionRes[0]?.version}`)

    // 2. Tables audit
    const tablesRes = await prisma.$queryRawUnsafe('SHOW TABLES')
    const tables = tablesRes.map(t => Object.values(t)[0])
    console.log(`Total Tables in zhealthos-db: ${tables.length}`)

    const hasPrismaMigrations = tables.includes('_prisma_migrations')
    const hasInvoiceIdemp = tables.includes('invoice_idempotency')
    const hasPaymentIdemp = tables.includes('payment_idempotency')

    console.log(`_prisma_migrations table exists: ${hasPrismaMigrations}`)
    console.log(`invoice_idempotency table exists: ${hasInvoiceIdemp}`)
    console.log(`payment_idempotency table exists: ${hasPaymentIdemp}`)

    if (hasPrismaMigrations) {
      const migs = await prisma.$queryRawUnsafe('SELECT id, migration_name, finished_at FROM _prisma_migrations')
      console.log('Applied Prisma Migrations in _prisma_migrations:', migs)
    }

    // 3. Entity counts
    const [
      clinics, branches, users, practitioners, patients, invoices, payments, appointments
    ] = await Promise.all([
      prisma.clinic.findMany(),
      prisma.branch.findMany(),
      prisma.user.findMany({ select: { id: true, email: true, name: true, role: true, status: true, profileData: true } }),
      prisma.practitioner.findMany(),
      prisma.patient.findMany({ select: { id: true, fullName: true, clinicId: true, status: true } }),
      prisma.invoice.findMany(),
      prisma.payment.findMany(),
      prisma.appointment.findMany()
    ])

    console.log('\n--- ENTITY SUMMARY ---')
    console.log(`Clinics: ${clinics.length}`)
    console.log(`Branches: ${branches.length}`)
    console.log(`Users: ${users.length}`)
    console.log(`Practitioners: ${practitioners.length}`)
    console.log(`Patients: ${patients.length}`)
    console.log(`Invoices: ${invoices.length}`)
    console.log(`Payments: ${payments.length}`)
    console.log(`Appointments: ${appointments.length}`)

    console.log('\n--- CLINICS ---')
    console.log(clinics.map(c => ({ id: c.id, name: c.name, email: c.email })))

    console.log('\n--- BRANCHES ---')
    console.log(branches.map(b => ({ id: b.id, clinicId: b.clinicId, name: b.name })))

    console.log('\n--- USERS (ADMIN/CLINIC) ---')
    console.log(users.map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, clinicId: u.profileData?.clinicId })))

    console.log('\n--- PRACTITIONERS ---')
    console.table(practitioners.map(p => ({ id: p.id, clinicId: p.clinicId, userId: p.userId, name: p.name, email: p.email, status: p.status })))

    console.log('\n--- INVOICES AUDIT ---')
    console.log(`Total Invoices: ${invoices.length}`)
    const invoiceSummary = invoices.map(i => ({
      displayId: i.displayId,
      patientName: i.patientName || i.clientName,
      practitioner: i.practitionerName,
      amount: i.amount,
      due: i.due,
      status: i.status,
      issueDate: i.issueDate
    }))
    console.table(invoiceSummary)

    // Check INV-000029 & INV-000028
    const inv29 = invoices.find(i => i.displayId === 'INV-000029')
    const inv28 = invoices.find(i => i.displayId === 'INV-000028')
    console.log('\nHISTORICAL INVOICES CHECK:')
    console.log('INV-000029:', inv29 ? { id: inv29.id, displayId: inv29.displayId, amount: inv29.amount, due: inv29.due, status: inv29.status, items: inv29.items } : 'NOT FOUND')
    console.log('INV-000028:', inv28 ? { id: inv28.id, displayId: inv28.displayId, amount: inv28.amount, due: inv28.due, status: inv28.status } : 'NOT FOUND (CONFIRMED DELETED)')

    console.log('\n--- PAYMENTS AUDIT ---')
    console.log(`Total Payments: ${payments.length}`)
    console.table(payments.map(p => ({
      receiptNumber: p.receiptNumber,
      clientName: p.clientName,
      amount: p.amount,
      paymentDate: p.paymentDate,
      paymentMethod: p.paymentMethod,
      invoiceReference: p.invoiceReference,
      status: p.status,
      transactionId: p.transactionId
    })))

    // Check payment linked to INV-000028
    const payLinked28 = payments.filter(p => (p.invoiceReference || '').includes('28'))
    console.log('Payments linked to INV-000028:', payLinked28)

    // Check payment linked to INV-000029
    const payLinked29 = payments.filter(p => (p.invoiceReference || '').includes('29'))
    console.log('Payments linked to INV-000029:', payLinked29)

    // 4. Financial Calculations
    console.log('\n--- FINANCIAL RECONCILIATION ON zhealthos-db ---')
    const totalPaymentsAmount = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0)
    const paidInvoices = invoices.filter(i => (i.status || '').toLowerCase() === 'paid')
    const totalPaidInvoicesAmount = paidInvoices.reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0)

    console.log(`Sum of all payment records in payments table: $${totalPaymentsAmount.toFixed(2)}`)
    console.log(`Sum of all invoices with status='Paid': $${totalPaidInvoicesAmount.toFixed(2)}`)

    const activeOutstanding = invoices
      .filter(i => {
        const s = (i.status || '').toLowerCase()
        return s !== 'paid' && s !== 'completed' && s !== 'cancelled' && s !== 'draft'
      })
      .reduce((sum, i) => sum + (i.due !== undefined && i.due !== null ? Math.max(0, parseFloat(i.due) || 0) : Math.max(0, parseFloat(i.amount) || 0)), 0)

    console.log(`Calculated Total Active Outstanding Due: $${activeOutstanding.toFixed(2)}`)

    // 5. Column & Schema Compatibility Check
    const [invCols, payCols] = await Promise.all([
      prisma.$queryRawUnsafe('DESCRIBE invoices'),
      prisma.$queryRawUnsafe('DESCRIBE payments')
    ])
    console.log('\n--- INVOICES TABLE SCHEMA IN zhealthos-db ---')
    console.table(invCols.map(c => ({ Field: c.Field, Type: c.Type, Null: c.Null, Key: c.Key })))

    console.log('\n--- PAYMENTS TABLE SCHEMA IN zhealthos-db ---')
    console.table(payCols.map(c => ({ Field: c.Field, Type: c.Type, Null: c.Null, Key: c.Key })))

  } catch (err) {
    console.error('Audit failed:', err)
  } finally {
    await prisma.$disconnect()
  }
}

runAudit()
