-- Replace WhatsApp with Telegram as the second alert delivery channel.

CREATE TYPE "NotificationChannel_email_telegram" AS ENUM ('EMAIL', 'TELEGRAM');

ALTER TABLE "Recipient"
  ADD COLUMN "telegramChatId" TEXT;

ALTER TABLE "EscalationStep" ALTER COLUMN "channels" DROP DEFAULT;

ALTER TABLE "EscalationStep"
  ALTER COLUMN "channels" TYPE "NotificationChannel_email_telegram"[]
  USING array_replace("channels"::text[], 'WHATSAPP', 'TELEGRAM')::"NotificationChannel_email_telegram"[];

ALTER TABLE "AlertNotification"
  ALTER COLUMN "channel" TYPE "NotificationChannel_email_telegram"
  USING replace("channel"::text, 'WHATSAPP', 'TELEGRAM')::"NotificationChannel_email_telegram";

ALTER TYPE "NotificationChannel" RENAME TO "NotificationChannel_old";
ALTER TYPE "NotificationChannel_email_telegram" RENAME TO "NotificationChannel";
DROP TYPE "NotificationChannel_old";

ALTER TABLE "EscalationStep"
  ALTER COLUMN "channels" SET DEFAULT ARRAY[]::"NotificationChannel"[];
