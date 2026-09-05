import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { issueCredential, listCredentials, revokeCredential } from './agent-credentials.service';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';

const issueBody = z.object({
  machineId: z.string().min(1),
  label: z.string().min(1).optional(),
});

/**
 * Admin-only credential management for per-agent auth. Reads are also
 * admin-only (unlike hosts/devices) — a credential list, even without raw
 * tokens, still maps machines to labels and reveals which hosts have been
 * revoked, which is operational detail worth the same protection as
 * GET /api/config.
 */
export const agentCredentialsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.requireRole('admin') }, async (req) => {
    const body = issueBody.safeParse(req.body);
    if (!body.success) {
      throw new ValidationError(body.error.message);
    }
    // Returned once, here, and never again — the same principle as a GitHub
    // PAT or a Stripe API key: only the hash is kept after this response.
    return issueCredential(body.data.machineId, body.data.label);
  });

  app.get('/', { preHandler: app.requireRole('admin') }, async () => {
    return listCredentials();
  });

  app.post('/:id/revoke', { preHandler: app.requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string };
    const revoked = await revokeCredential(id);
    if (!revoked) {
      throw new NotFoundError('Agent credential not found');
    }
    return revoked;
  });
};
