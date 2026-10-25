/**
 * Knowledge base for Chat with God. Each entry is one topic; the service sends only
 * the entries that best match the user's question. Edit freely: plain text, no secrets.
 * Kept as TypeScript (not .md) so `nest build` always ships it inside dist.
 */
export type KnowledgeEntry = { title: string; keywords: string[]; content: string };

export const KNOWLEDGE: KnowledgeEntry[] = [
  {
    title: 'About DARKFANTASY',
    keywords: ['app', 'about', 'what', 'darkfantasy', 'dark', 'fantasy', 'community', 'purpose'],
    content:
      'DARKFANTASY is a private social community app. Members share posts, follow each other, chat directly or in groups, join events and keep private photos in a Photo Vault. The main tabs are Home (feed), Discover, Events, Chats, Activity and Profile.',
  },
  {
    title: 'Accounts, sign up and login',
    keywords: ['account', 'signup', 'sign', 'register', 'login', 'log', 'password', 'forgot', 'reset', 'invite', 'code', 'email', 'verify', 'approved', 'pending'],
    content:
      'New members register with their profile details. Some deployments are invite-only and require an invite code on the welcome screen. New accounts may need staff approval before they can use the full app. Forgotten passwords are reset from the login screen with "Forgot password", which sends an email. Email and password are changed in Settings > Account. Log out from Settings > Log out, which securely clears the session from the device.',
  },
  {
    title: 'Posts and the feed',
    keywords: ['post', 'posts', 'feed', 'home', 'create', 'upload', 'photo', 'video', 'caption', 'like', 'comment', 'share', 'audience', 'visibility', 'edit', 'delete'],
    content:
      'Create a post with the + button: pick photos or videos, add a caption and choose the audience. Uploads are checked by automatic moderation before they appear. Posts show in the Home feed, where members can like and comment. Authors can edit or delete their own posts from the post menu.',
  },
  {
    title: 'Premium content and subscriptions',
    keywords: ['premium', 'subscribe', 'subscription', 'locked', 'lock', 'blur', 'blurred', 'pay', 'payment', 'subscriber', 'tier', 'exclusive'],
    content:
      'Some posts are marked premium. Members without access see a blurred preview with a lock and a "Subscribe to view" button. Subscribers see the full photos and videos. When creating or editing a post, the author can choose whether it is normal or premium.',
  },
  {
    title: 'Chats and groups',
    keywords: ['chat', 'chats', 'message', 'messages', 'dm', 'direct', 'group', 'groups', 'send', 'typing', 'read', 'receipt', 'media', 'attachment', 'unread'],
    content:
      'The Chats tab lists direct and group conversations, with unread counts on the tab. Start a direct chat from a member profile. Members with permission can create groups. Photos can be shared in chats. Messages that fail to send can be retried from the message.',
  },
  {
    title: 'Following and requests',
    keywords: ['follow', 'follower', 'followers', 'following', 'request', 'requests', 'accept', 'decline', 'activity', 'notification', 'notifications'],
    content:
      'Members can follow each other. Follow requests and notifications appear in the Activity tab, which shows a badge for new items. Requests can be accepted or declined there.',
  },
  {
    title: 'Discover',
    keywords: ['discover', 'find', 'search', 'people', 'nearby', 'distance', 'explore', 'members'],
    content:
      'The Discover tab helps members find other people in the community. Members can control whether their distance and active status are shown in Settings > Privacy.',
  },
  {
    title: 'Events',
    keywords: ['event', 'events', 'join', 'apply', 'application', 'capacity', 'deadline', 'organizer', 'online', 'meeting', 'participant', 'participants'],
    content:
      'The Events tab lists community events. Open an event to see details and apply to join. Applications close after the registration deadline, when the event is full, or when it is canceled or completed. The organizer accepts or declines applications. A declined applicant cannot reapply unless the organizer removes their existing application. Online events show the meeting details the organizer provided. Members with permission can create and edit events.',
  },
  {
    title: 'Photo Vault',
    keywords: ['vault', 'private', 'hidden', 'hide', 'pin', 'biometric', 'fingerprint', 'face', 'lock', 'unlock', 'export', 'backup', 'sync', 'gallery'],
    content:
      'The Photo Vault (Settings > Photo Vault) keeps private photos and videos inside the app, separate from the phone gallery. It is protected by a vault PIN or the device biometric/screen lock, locks again when the app goes to the background, and blocks screenshots in release builds. Items can be hidden, reordered, synced to the member\'s private cloud storage, and exported to the gallery only after explicit confirmation. Logging out warns about unsynced vault changes.',
  },
  {
    title: 'Safety: blocking and reporting',
    keywords: ['block', 'blocked', 'unblock', 'report', 'reports', 'harass', 'abuse', 'safety', 'spam', 'inappropriate', 'moderation'],
    content:
      'To report a member or content, open their profile or the post menu and choose Report. Track the status of your reports in Settings > My reports. Blocking a member hides them and their content from you and stops them contacting you. Manage blocked members in Settings > Blocked users. Staff review reports in a dedicated moderation area.',
  },
  {
    title: 'Settings and privacy',
    keywords: ['settings', 'privacy', 'theme', 'dark', 'light', 'appearance', 'mode', 'active', 'status', 'read', 'receipts', 'distance', 'profile', 'edit', 'avatar'],
    content:
      'Settings is opened from the Profile tab. Appearance offers Dark (Velvet Noir), Light, or the device setting. Privacy controls distance, active status and read receipts. Edit your profile and photos from the Profile tab.',
  },
];
