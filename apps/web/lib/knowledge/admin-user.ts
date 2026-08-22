export function parseAdminUserIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isAdminUser(
  user: { id?: string | null; role?: string | null } | null | undefined,
) {
  if (!(user?.id || user?.role)) {
    return false;
  }

  const adminIds = parseAdminUserIds();
  return user?.role === "admin" || (user?.id ? adminIds.has(user.id) : false);
}
