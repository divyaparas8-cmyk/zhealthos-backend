const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  const defaultPasswordHash = await bcrypt.hash('Password123!', 10)

  // 1. Seed Super Admin
  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@zhealth.com' },
    update: { displayId: 'ADM-000001' },
    create: {
      displayId: 'ADM-000001',
      email: 'admin@zhealth.com',
      passwordHash: defaultPasswordHash,
      name: 'Alex Sadman (Super Admin)',
      phone: '+61 400 000 001',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
    },
  })

  // 2. Seed Clinic Admin
  const clinicAdmin = await prisma.user.upsert({
    where: { email: 'clinicadmin@zhealth.com' },
    update: { displayId: 'ADM-000002' },
    create: {
      displayId: 'ADM-000002',
      email: 'clinicadmin@zhealth.com',
      passwordHash: defaultPasswordHash,
      name: 'Zoya Rahman (Clinic Admin)',
      phone: '+61 400 000 002',
      role: 'CLINIC_ADMIN',
      status: 'ACTIVE',
    },
  })

  // 3. Seed Practitioner User & Profile
  const practitionerUser = await prisma.user.upsert({
    where: { email: 'sarah.jenkins@clinic.com' },
    update: { displayId: 'USR-000001' },
    create: {
      displayId: 'USR-000001',
      email: 'sarah.jenkins@clinic.com',
      passwordHash: defaultPasswordHash,
      name: 'Dr. Sarah Jenkins',
      phone: '+61 412 100 001',
      role: 'PRACTITIONER',
      status: 'ACTIVE',
    },
  })

  await prisma.practitioner.upsert({
    where: { email: 'sarah.jenkins@clinic.com' },
    update: {},
    create: {
      userId: practitionerUser.id,
      name: 'Dr. Sarah Jenkins',
      specialty: 'Physiotherapist',
      color: '#30D2BE',
      email: 'sarah.jenkins@clinic.com',
      phone: '+61 412 100 001',
      status: 'Active',
      joinDate: 'Jan 1, 2025',
      qualifications: ['BPhty (Hons)', 'APAM Member'],
      bio: 'Experienced physiotherapist specialising in musculoskeletal injuries.',
      consultationFee: 180,
    },
  })

  // 4. Seed Sales Executive User
  const salesUser = await prisma.user.upsert({
    where: { email: 'sales@zhealth.com' },
    update: { displayId: 'SAL-000001' },
    create: {
      displayId: 'SAL-000001',
      email: 'sales@zhealth.com',
      passwordHash: defaultPasswordHash,
      name: 'Michael Scott (Sales Exec)',
      phone: '+61 400 000 003',
      role: 'SALES_EXECUTIVE',
      status: 'ACTIVE',
    },
  })

  // 5. Seed Patient User & Profile
  const patientUser = await prisma.user.upsert({
    where: { email: 'patient@zhealth.com' },
    update: { displayId: 'PAT-000001' },
    create: {
      displayId: 'PAT-000001',
      email: 'patient@zhealth.com',
      passwordHash: defaultPasswordHash,
      name: 'Oliver Vance',
      phone: '+61 412 888 999',
      role: 'PATIENT',
      status: 'ACTIVE',
    },
  })

  await prisma.patient.upsert({
    where: { userId: patientUser.id },
    update: { displayId: 'PAT-000001' },
    create: {
      displayId: 'PAT-000001',
      userId: patientUser.id,
      fullName: 'Oliver Vance',
      dob: '1988-03-24',
      gender: 'Male',
      email: 'patient@zhealth.com',
      phone: '+61 412 888 999',
      address: '45 Collins Street',
      city: 'Melbourne',
      state: 'VIC',
      postcode: '3000',
      sessionsAllocated: 12,
      sessionsUsed: 3,
      status: 'active',
      diagnosis: ['Rotator Cuff Tendinopathy', 'Postural Kyphosis'],
      notes: 'NDIS Plan Managed - Progressing well with upper limb resistance rehab.'
    },
  })

  // 6. Seed Branches
  const b1 = await prisma.branch.create({
    data: {
      name: 'Melbourne Central Allied Clinic',
      email: 'melbourne@zhealth.com',
      phone: '+61 3 9000 1111',
      address: '123 Care Street, Melbourne VIC 3000',
      status: 'Active',
    },
  }).catch(() => null)

  // 7. Seed Realistic Appointments
  await prisma.appointment.createMany({
    data: [
      {
        displayId: 'APT-000001',
        patientName: 'Oliver Vance',
        practitionerName: 'Dr. Sarah Jenkins',
        branchName: 'Melbourne Central Allied Clinic',
        serviceName: 'Physiotherapy Initial Consultation',
        date: new Date().toISOString().split('T')[0],
        startTime: '09:00',
        endTime: '10:00',
        status: 'Scheduled',
        fee: 180,
        location: 'Melbourne Central Allied Clinic',
        room: 'Room 1'
      },
      {
        displayId: 'APT-000002',
        patientName: 'Emily Taylor',
        practitionerName: 'Dr. Sarah Jenkins',
        branchName: 'Melbourne Central Allied Clinic',
        serviceName: 'Occupational Therapy Review',
        date: new Date().toISOString().split('T')[0],
        startTime: '11:00',
        endTime: '12:00',
        status: 'Completed',
        fee: 195,
        location: 'Melbourne Central Allied Clinic',
        room: 'Room 2'
      }
    ],
    skipDuplicates: true,
  })

  // 8. Seed Realistic Waitlist Entries
  await prisma.waitlist.createMany({
    data: [
      {
        clientName: 'Charlotte Hughes',
        contactNumber: '+61 411 222 333',
        preferredPractitioner: 'Dr. Sarah Jenkins',
        appointmentType: 'Initial Assessment',
        preferredDate: new Date().toISOString().split('T')[0],
        status: 'Waiting',
        branch: 'Melbourne Central Allied Clinic'
      },
      {
        clientName: 'Liam Patterson',
        contactNumber: '+61 414 555 777',
        preferredPractitioner: 'Dr. Sarah Jenkins',
        appointmentType: 'Hydrotherapy Session',
        preferredDate: new Date().toISOString().split('T')[0],
        status: 'Waiting',
        branch: 'Melbourne Central Allied Clinic'
      }
    ],
    skipDuplicates: true,
  })

  console.log('✅ Seeding completed successfully!')
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
