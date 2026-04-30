function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false });
  }
  next();
}

function requireDeveloper(req, res, next) {
  if (!req.session.user || req.session.user.role !== "developer") {
    return res.status(403).json({ success: false });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !["admin","developer"].includes(req.session.user?.role)) {
    return res.status(403).json({ success: false });
  }
  next();
}

function requireAdminOrDev(req, res, next) {
  const role = req.session?.user?.role;

  if (role !== "admin" && role !== "developer") {
    return res.status(403).json({ error: "Access denied" });
  }

  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireDeveloper,
  requireAdminOrDev
};