// One-line wording for each sync state
export function statusText(state: string, lastSyncedAt: number | null): string {
  switch (state) {
    case 'synced':
      return lastSyncedAt
        ? `Synced · ${new Date(lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : 'Synced'
    case 'saving':
      return 'Saving…'
    case 'offline':
      return 'Can’t reach the cloud — retrying'
    case 'conflict':
      return 'Changed on another device'
    case 'stale':
      return 'Newer changes on another device'
    case 'signed-out':
      return 'Signed out'
    default:
      return ''
  }
}
