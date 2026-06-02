const db = require("../db");

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

function requireOperationAccess(req, res, next) {

  const role = req.session?.user?.role;

  if (
    !["developer", "admin", "payment"].includes(role)
  ) {
    return res.status(403).json({
      success: false,
      message: "Access denied"
    });
  }

  next();
}

function requirePermission(permission) {

  return (req, res, next) => {

    const role = req.session?.user?.role;

    if (!role) {
      return res.status(401).json({
        success: false
      });
    }

    if (role === "developer") {
      return next();
    }

    db.get(`
      SELECT allowed
      FROM role_permissions
      WHERE role=?
      AND permission=?
    `, [role, permission], (err, row) => {

      if (err) {
        return res.status(403).json({
          success: false,
          message: "Access denied"
        });
      }

      if (!row && permission.startsWith("view_page_")) {
        return next();
      }

      if (!row || row.allowed !== 1) {
        return res.status(403).json({
          success: false,
          message: "Access denied"
        });
      }

      next();

    });

  };

}

function requireAnyPermission(permissions) {

  return (req, res, next) => {

    const role = req.session?.user?.role;

    if (!role) {
      return res.status(401).json({
        success: false
      });
    }

    if (role === "developer") {
      return next();
    }

    const placeholders = permissions.map(() => "?").join(",");

    db.all(`
      SELECT permission, allowed
      FROM role_permissions
      WHERE role=?
      AND permission IN (${placeholders})
    `, [role, ...permissions], (err, rows = []) => {

      if (err) {
        return res.status(403).json({
          success: false,
          message: "Access denied"
        });
      }

      const rowByPermission = new Map(
        rows.map(row => [row.permission, row])
      );

      const allowed = permissions.some(permission => {
        const row = rowByPermission.get(permission);

        if (!row && permission.startsWith("view_page_")) {
          return true;
        }

        return row?.allowed === 1;
      });

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: "Access denied"
        });
      }

      next();

    });

  };

}

module.exports = {
  requireAuth,
  requireAdmin,
  requireDeveloper,
  requireAdminOrDev,
  requireOperationAccess,
  requirePermission,
  requireAnyPermission
};
