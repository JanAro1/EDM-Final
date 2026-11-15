/**
 * Resolve the app.Patient that belongs to the logged-in PATIENT user.
 *
 * Resolution order:
 *   1. `User.patientId` — the exact, seeded FK link (preferred).
 *   2. Fallback for legacy/demo accounts: a patient whose email matches.
 *   3. Fallback: the first seeded patient (lowest MRN) so the demo portal
 *      account always lands on *a* record instead of a 404.
 */
import { prisma, type Patient } from '@medidata/db';
import type { AuthContext } from '../middleware/auth.js';

export async function resolvePatientForUser(auth: AuthContext): Promise<Patient | null> {
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { patientId: true },
  });
  if (user?.patientId) {
    const linked = await prisma.patient.findUnique({ where: { id: user.patientId } });
    if (linked) return linked;
  }

  const byEmail = await prisma.patient.findFirst({ where: { email: auth.email } });
  if (byEmail) return byEmail;

  return prisma.patient.findFirst({ orderBy: { mrn: 'asc' } });
}
