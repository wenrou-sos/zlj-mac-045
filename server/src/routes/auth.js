import { Router } from 'express';
import { login, logout, ROLE_LABEL } from '../auth.js';

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = await login(username, password);
    res.json({
      token: result.token,
      expires_in_hours: result.expires_in_hours,
      user: { ...result.user, role_label: ROLE_LABEL[result.user.role] || result.user.role },
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const auth = req.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    await logout(token);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
