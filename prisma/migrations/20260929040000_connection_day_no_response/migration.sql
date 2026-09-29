-- Business silence at the 2.5-hour deadline is not the same as "no surplus".
ALTER TYPE "ConnectionDayOutcome" ADD VALUE IF NOT EXISTS 'NO_RESPONSE';
