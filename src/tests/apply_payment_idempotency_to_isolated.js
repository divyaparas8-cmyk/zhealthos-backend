const fs = require('fs')
const path = require('path')
const { PrismaClient } = require('@prisma/client')

const ISOLATED_TEST_DB_URL = 'mysql://root:@127.0.0.1:3306/zhealthos_isolated_test'

const testPrisma = new PrismaClient({
  datasources: {
    db: {
      url: ISOLATED_TEST_DB_URL
    }
  }
})

async function applyMigration() {
  try {
    console.log('Connecting to isolated test database:', ISOLATED_TEST_DB_URL)
    const dbName = await testPrisma.$queryRawUnsafe('SELECT DATABASE() as db')
    console.log('Current Database:', dbName)
    if (dbName[0]?.db !== 'zhealthos_isolated_test') {
      throw new Error(`SAFETY ERROR: Expected zhealthos_isolated_test, but got ${dbName[0]?.db}`)
    }

    const migrationSqlPath = path.resolve(__dirname, '../../prisma/migrations/20261017_add_payment_idempotency/migration.sql')
    const sql = fs.readFileSync(migrationSqlPath, 'utf8')
    console.log('Loaded migration SQL from:', migrationSqlPath)

    // Execute statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0)

    for (const stmt of statements) {
      console.log('Executing:', stmt.substring(0, 50) + '...')
      await testPrisma.$executeRawUnsafe(stmt)
    }

    const tableDesc = await testPrisma.$queryRawUnsafe('DESCRIBE `payment_idempotency`')
    console.log('Table `payment_idempotency` created successfully:')
    console.table(tableDesc)

    const indexes = await testPrisma.$queryRawUnsafe('SHOW INDEX FROM `payment_idempotency`')
    console.log('Indexes on `payment_idempotency`:')
    console.table(indexes)
  } catch (err) {
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    await testPrisma.$disconnect()
  }
}

applyMigration()
