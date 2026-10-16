-- CreateTable: invoice_idempotency
-- Reviewed Migration: Adds dedicated idempotency tracking table scoped to clinicId
CREATE TABLE `invoice_idempotency` (
    `id` VARCHAR(191) NOT NULL,
    `clinicId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `requestHash` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `invoice_idempotency_invoiceId_key`(`invoiceId`),
    UNIQUE INDEX `clinic_idempotency_key_idx`(`clinicId`, `idempotencyKey`),
    INDEX `invoice_idempotency_clinicId_idx`(`clinicId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `invoice_idempotency` ADD CONSTRAINT `invoice_idempotency_invoiceId_fkey` 
FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
