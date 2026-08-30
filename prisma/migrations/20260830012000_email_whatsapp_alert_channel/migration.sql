-- Enable WhatsApp as the second alert delivery channel.

CREATE TYPE "NotificationChannel_email_whatsapp" AS ENUM ('EMAIL', 'WHATSAPP');

ALTER TABLE "EscalationStep" ALTER COLUMN "channels" DROP DEFAULT;

ALTER TABLE "EscalationStep"
  ALTER COLUMN "channels" TYPE "NotificationChannel_email_whatsapp"[]
  USING "channels"::text[]::"NotificationChannel_email_whatsapp"[];

ALTER TABLE "AlertNotification"
  ALTER COLUMN "channel" TYPE "NotificationChannel_email_whatsapp"
  USING "channel"::text::"NotificationChannel_email_whatsapp";

ALTER TYPE "NotificationChannel" RENAME TO "NotificationChannel_old";
ALTER TYPE "NotificationChannel_email_whatsapp" RENAME TO "NotificationChannel";
DROP TYPE "NotificationChannel_old";

ALTER TABLE "EscalationStep"
  ALTER COLUMN "channels" SET DEFAULT ARRAY[]::"NotificationChannel"[];
