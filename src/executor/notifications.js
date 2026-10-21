import { runGh } from './core.js'

/**
 * List notifications.
 * @param filter
 */
export async function listNotifications(filter = {}) {
  const args = [
    'api', 'notifications',
    '--jq', '[.[] | {id: .id, unread: .unread, reason: .reason, subject: {title: .subject.title, type: .subject.type, url: .subject.url}, repository: {fullName: .repository.full_name, name: .repository.name}, updatedAt: .updated_at}]',
  ]
  if (filter.all) {
    args.push('--method', 'GET', '-f', 'all=true')
  }
  return runGh(args)
}

/**
 * Mark all notifications as read in a single API call.
 */
export async function markAllNotificationsRead() {
  return runGh(['api', 'notifications', '--method', 'PUT', '--field', 'read=true'])
}

/**
 * Mark a notification as read.
 * @param notificationId
 */
export async function markNotificationRead(notificationId) {
  const args = [
    'api', `notifications/threads/${encodeURIComponent(notificationId)}`,
    '--method', 'PATCH',
  ]
  return runGh(args)
}

// ─── PR diff and comment functions ───────────────────────────────────────────
