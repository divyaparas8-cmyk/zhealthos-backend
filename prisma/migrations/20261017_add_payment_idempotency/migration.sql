-- CreateTable: payment_idempotency
-- Reviewed Migration: Adds dedicated payment idempotency tracking table scoped to clinicId
CREATE TABLE `payment_idempotency` (
    `id` VARCHAR(191) NOT NULL,
    `clinicId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `requestHash` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_idempotency_paymentId_key`(`paymentId`),
    UNIQUE INDEX `clinic_payment_idempotency_key_idx`(`clinicId`, `idempotencyKey`),
    INDEX `payment_idempotency_clinicId_idx`(`clinicId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payment_idempotency` ADD CONSTRAINT `payment_idempotency_paymentId_fkey` 
FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
