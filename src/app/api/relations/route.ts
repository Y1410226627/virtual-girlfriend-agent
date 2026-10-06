// 伴侣关系网：GET 谁与谁友好/吃醋（关系值 -100..100）
import { withCompanion } from '@/lib/companion-context';
import { resolveCompanionId } from '@/lib/companion';
import { listRelations } from '@/lib/companion-relations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const id = resolveCompanionId(req);
  return withCompanion(id, () => Response.json({ relations: listRelations() }));
}
