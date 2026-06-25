-- CreateEnum
CREATE TYPE "TokenPlatform" AS ENUM ('IOS', 'ANDROID');

-- CreateEnum
CREATE TYPE "TokenType" AS ENUM ('APNS', 'FCM', 'EXPO');

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "TokenPlatform" NOT NULL,
    "tokenType" "TokenType" NOT NULL,
    "tokenMode" TEXT NOT NULL DEFAULT 'prod',
    "appVersion" TEXT,
    "appBuild" TEXT,
    "appBundle" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "deactivationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_records" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "channel" TEXT NOT NULL DEFAULT 'push',
    "deepLink" TEXT,
    "imageUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "priorityWeight" INTEGER NOT NULL DEFAULT 1,
    "targetUserIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "isBroadcast" BOOLEAN NOT NULL DEFAULT false,
    "targetPlatform" TEXT NOT NULL DEFAULT 'all',
    "totalTargets" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "failedTokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_userId_isActive_idx" ON "device_tokens"("userId", "isActive");

-- CreateIndex
CREATE INDEX "device_tokens_isActive_idx" ON "device_tokens"("isActive");

-- CreateIndex
CREATE INDEX "notification_records_status_idx" ON "notification_records"("status");

-- CreateIndex
CREATE INDEX "notification_records_createdAt_idx" ON "notification_records"("createdAt");

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
