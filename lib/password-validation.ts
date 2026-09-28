export function profilePasswordError(password: string, confirmation: string) {
  if ((password || confirmation) && password !== confirmation)
    return "The new passwords do not match.";
  if (password.length > 0 && (password.length < 6 || password.length > 256))
    return "New password must be between 6 and 256 characters.";
  return null;
}
