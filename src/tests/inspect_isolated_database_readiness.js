const { PrismaClient } = require('@prisma/client')

const isolatedPrisma = new PrismaClient({
  datasources: {
    db: {
      url: 'mysql://root:@127.0.0.1:3306/zhealthos_isolated_test'
    }
  }
})

async function inspect() {
  try {
    const dbName = await isolatedPrisma.$queryRawUnsafe('SELECT DATABASE() as db')
    console.log('Target DB:', dbName[0]?.db)

    const tables = await isolatedPrisma.$queryRawUnsafe('SHOW TABLES')
    const tableNames = tables.map(t => Object.values(t)[0])
    console.log(`Total Tables in zhealthos_isolated_test: ${tableNames.length}`)
    console.log('Tables:', tableNames)

    const hasInvoiceIdemp = tableNames.includes('invoice_idempotency')
    const hasPaymentIdemp = tableNames.includes('payment_idempotency')
    console.log('\nIdempotency Tables Status:')
    console.log('  invoice_idempotency:', hasInvoiceIdemp ? 'PRESENT' : 'MISSING')
    console.log('  payment_idempotency:', hasPaymentIdemp ? 'PRESENT' : 'MISSING')

    console.log('\nEntity Row Counts:')
    const counts = {}
    for (const model of ['user', 'clinic', 'practitioner', 'patient', 'invoice', 'payment', 'appointment', 'branch', 'invoiceIdempotency', 'paymentIdempotency']) {
      try {
        counts[model] = await isolatedPrisma[model].count()
      } catch (e) {
        counts[model] = `Error: ${e.message}`
      }
    }
    console.table(counts)

    // Check users for login
    const users = await isolatedPrisma.user.findMany({ select: { id: true, email: true, role: true, clinicId: true } })
    console.log('\nExisting Users in isolated DB:')
    console.table(users)

    // Check clinics
    const clinics = await isolatedPrisma.clinic.findMany()
    console.log('\nExisting Clinics in isolated DB:')
    console.table(clinics)

    // Check practitioners
    const practitioners = await isolatedPrisma.practitioner.findMany({ select: { id: true, name: true, email: true, clinicId: true } })
    console.log('\nExisting Practitioners in isolated DB:')
    console.table(practitioners)

    // Check patients
    const patients = await isolatedPrisma.patient.findMany({ select: { id: true, fullName: true, email: true, clinicId: true } })
    console.log('\nExisting Patients in isolated DB:')
    console.table(patients)

    // Check invoices
    const invoices = await isolatedPrisma.invoice.findMany({ select: { id: true, displayId: true, amount: true, due: true, status: true, clinicId: true } })
    console.log('\nExisting Invoices in isolated DB:')
    console.table(invoices)

    // Check payments
    const payments = await isolatedPrisma.payment.findMany({ select: { id: true, receiptNumber: true, amount: true, invoiceReference: true, clinicId: true } })
    console.log('\nExisting Payments in isolated DB:')
    console.table(payments)

  } catch (err) {
    console.error('Inspection failed:', err)
  } finally {
    await isolatedPrisma.$disconnect()
  }
}

inspect()
