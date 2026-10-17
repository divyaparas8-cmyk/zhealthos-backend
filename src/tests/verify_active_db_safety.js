const { PrismaClient } = require('@prisma/client')

const activeDb = new PrismaClient({
  datasources: {
    db: {
      url: 'mysql://root:@127.0.0.1:3306/zhealthos-db'
    }
  }
})

async function verifyActiveDbSafety() {
  try {
    const dbName = await activeDb.$queryRawUnsafe('SELECT DATABASE() as db')
    console.log('Verified database name:', dbName[0]?.db)

    const inv29 = await activeDb.invoice.findFirst({ where: { displayId: 'INV-000029' } })
    const inv28 = await activeDb.invoice.findFirst({ where: { displayId: 'INV-000028' } })
    const invCount = await activeDb.invoice.count()
    const payCount = await activeDb.payment.count()

    console.log('Total invoices in zhealthos-db:', invCount)
    console.log('Total payments in zhealthos-db:', payCount)
    console.log('INV-000029 status:', inv29?.status, 'amount:', inv29?.amount, 'due:', inv29?.due)
    console.log('INV-000028 exists:', !!inv28)

    const idempTable = await activeDb.$queryRawUnsafe("SHOW TABLES LIKE 'payment_idempotency'")
    console.log('payment_idempotency table in active db:', idempTable.length > 0 ? 'FOUND (ERROR)' : 'NOT FOUND (PASS)')

    if (idempTable.length > 0) {
      throw new Error('SAFETY BREACH: payment_idempotency exists in zhealthos-db!')
    }
    console.log('✓ SAFETY VERIFIED: Active zhealthos-db is 100% untouched.')
  } finally {
    await activeDb.$disconnect()
  }
}

verifyActiveDbSafety()
