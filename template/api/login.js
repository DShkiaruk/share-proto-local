import { createToken } from '../lib/session.js';
import { applyCors } from '../lib/cors.js';

const SIXTY_DAYS_S = 60 * 24 * 60 * 60;

export default async function handler(req, res) {
  if (applyCors(req, res, process.env.ALLOWED_ORIGINS)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { password, name } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) {
    return res.status(400).json({ error: 'Missing name' });
  }
  const role =
    password && password === process.env.DESIGNER_PASSWORD
      ? 'designer'
      : password && password === process.env.CLIENT_PASSWORD
        ? 'client'
        : null;
  if (!role) {
    await new Promise((r) => setTimeout(r, 800));
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = await createToken(
    { r: role, n: cleanName, exp: Date.now() + SIXTY_DAYS_S * 1000 },
    process.env.SESSION_SECRET
  );
  res.setHeader(
    'Set-Cookie',
    `fp_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SIXTY_DAYS_S}`
  );
  // The token also goes in the body: embed mode (overlay on a foreign page)
  // can't use cross-site cookies and sends it back as a Bearer header.
  return res.status(200).json({ role, token });
}
