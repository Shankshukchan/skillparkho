import jwt from 'jsonwebtoken';

export function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password required' });
  }
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (email !== adminEmail || password !== adminPassword) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  const payload = {
    email: adminEmail,
    role: 'admin',
    name: 'SkillParkho Admin'
  };

  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });

  res.json({
    success: true,
    token,
    admin: payload,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

export function me(req, res) {
  res.json({ success: true, admin: req.admin });
}

export function verifyToken(req, res) {
  res.json({ success: true, valid: true, admin: req.admin });
}
