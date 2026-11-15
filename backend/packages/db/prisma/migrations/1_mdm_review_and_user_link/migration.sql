-- MediData migration 1: patient↔user link + MDM merge-review queue.
-- Additive only — safe to run against an existing seeded database.

-- ---------------------------------------------------------------------------
-- app.User.patientId — exact PATIENT-role scoping (replaces email heuristics)
-- ---------------------------------------------------------------------------
ALTER TABLE "app"."User" ADD COLUMN "patientId" TEXT;

CREATE UNIQUE INDEX "User_patientId_key" ON "app"."User"("patientId");

ALTER TABLE "app"."User"
  ADD CONSTRAINT "User_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "app"."Patient"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- gov.MdmMergeCandidate — human-in-the-loop duplicate review queue
-- ---------------------------------------------------------------------------
CREATE TABLE "gov"."MdmMergeCandidate" (
    "id" TEXT NOT NULL,
    "goldenId" TEXT NOT NULL,
    "leftPatientId" TEXT NOT NULL,
    "rightPatientId" TEXT NOT NULL,
    "matchScore" DOUBLE PRECISION NOT NULL,
    "matchReasons" JSONB NOT NULL,
    "survivorshipRule" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,

    CONSTRAINT "MdmMergeCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MdmMergeCandidate_leftPatientId_rightPatientId_key"
  ON "gov"."MdmMergeCandidate"("leftPatientId", "rightPatientId");

CREATE INDEX "MdmMergeCandidate_status_idx" ON "gov"."MdmMergeCandidate"("status");
CREATE INDEX "MdmMergeCandidate_goldenId_idx" ON "gov"."MdmMergeCandidate"("goldenId");

ALTER TABLE "gov"."MdmMergeCandidate"
  ADD CONSTRAINT "MdmMergeCandidate_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "app"."User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
