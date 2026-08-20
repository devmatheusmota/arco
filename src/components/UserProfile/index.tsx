import { LogOut, Settings, Users } from 'lucide-react'
import { useRef, useState } from 'react'

import { useOnClickOutside } from '../../hooks/useOnClickOutside'
import { useOnEscape } from '../../hooks/useOnEscape'
import { useT } from '../../lib/i18n'
import { getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Avatar } from '../ui/Avatar'
import styles from './UserProfile.module.css'

export function UserProfile() {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal_)
  const preferences = useProjectsStore((s) => s.preferences)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)
  const profiles = useProjectsStore((s) => s.profiles)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const displayName = preferences.displayName || t('profile.fallbackName')
  const avatarUrl = getProfileImageUrl(preferences)
  const initial = getProfileInitial(displayName)
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null

  const logout = () => {
    setPreferences({
      accountCreated: false,
      displayName: '',
      profileImageUrl: '',
    })
    setOpen(false)
  }

  useOnClickOutside(ref, () => setOpen(false), open)
  useOnEscape(() => setOpen(false), open)

  return (
    <div ref={ref} className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        onClick={() => setOpen((v) => !v)}
        aria-label={t('profile.menuLabel')}
        title={displayName}
      >
        <Avatar key={avatarUrl} src={avatarUrl} initial={initial} className={styles.avatar} />
        <span className={styles.identity}>
          <span className={styles.name}>{displayName}</span>
          <span className={styles.email}>
            {t('profile.localAccount')}
            {activeProfile ? ` · ${activeProfile.name}` : ''}
          </span>
        </span>
        <Settings size={14} className={styles.gear} />
      </button>

      {open ? (
        <div className={styles.popover} role="menu">
          <div className={styles.popHeader}>
            <Avatar
              key={avatarUrl}
              src={avatarUrl}
              initial={initial}
              className={styles.popAvatar}
            />
            <div className={styles.popIdentity}>
              <strong className={styles.popName}>{displayName}</strong>
              <span className={styles.popEmail}>{t('profile.localAccount')}</span>
            </div>
          </div>
          <div className={styles.divider} />
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              openModal('preferences')
              setOpen(false)
            }}
          >
            <Settings size={14} />
            {t('profile.preferences')}
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              openModal('profiles')
              setOpen(false)
            }}
          >
            <Users size={14} />
            <span>{t('profile.manageAccounts')}</span>
          </button>
          <button type="button" className={`${styles.item} ${styles.dangerItem}`} onClick={logout}>
            <LogOut size={14} />
            <span>{t('profile.logout')}</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
