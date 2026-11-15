import { prisma } from '@medidata/db';

const counts = {
  dimPatient: await prisma.dimPatient.count(),
  factEncounter: await prisma.factEncounter.count(),
  factLabResult: await prisma.factLabResult.count(),
  factClaim: await prisma.factClaim.count(),
  dimProvider: await prisma.dimProvider.count(),
  dimLocation: await prisma.dimLocation.count(),
  dimPayer: await prisma.dimPayer.count(),
  dimDate: await prisma.dimDate.count(),
  dimTest: await prisma.dimTestCatalog.count(),
  staging: await prisma.rawSourceRecord.count(),
  mdmMaster: await prisma.mdmMaster.count(),
  mdmCand: await prisma.mdmMergeCandidate.count(),
  outbox: await prisma.outboxEvent.count(),
  dqResults: await prisma.dqResult.count(),
  pipelineRuns: await prisma.pipelineRun.count(),
};

console.log(counts);
await prisma.$disconnect();
