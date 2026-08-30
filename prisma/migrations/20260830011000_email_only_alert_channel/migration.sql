-- Keep alert delivery on email only.

CREATE TYPE "NotificationChannel_email_only" AS ENUM ('EMAIL');

DELETE FROM "AlertNotification"
WHERE "channel"::text <> 'EMAIL';

ALTER TABLE "EscalationStep" ALTER COLUMN "channels" DROP DEFAULT;

UPDATE "EscalationStep"
SET "channels" = ARRAY['EMAIL']::"NotificationChannel"[];

ALTER TABLE "EscalationStep"
  ALTER COLUMN "channels" TYPE "NotificationChannel_email_only"[]
  USING "channels"::text[]::"NotificationChannel_email_only"[];

ALTER TABLE "AlertNotification"
  ALTER COLUMN "channel" TYPE "NotificationChannel_email_only"
  USING "channel"::text::"NotificationChannel_email_only";

ALTER TYPE "NotificationChannel" RENAME TO "NotificationChannel_old";
ALTER TYPE "NotificationChannel_email_only" RENAME TO "NotificationChannel";
DROP TYPE "NotificationChannel_old";

ALTER TABLE "EscalationStep"
  ALTER COLUMN "channels" SET DEFAULT ARRAY[]::"NotificationChannel"[];
