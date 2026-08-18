import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { getProfileImageUrl, getProfileInitial } from '../../lib/profile'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './WelcomeModal.module.css'

const PRODUCT_NAME = 'Arco'

function daysSince(ts: number | null): number {
  if (!ts) return 1
  const diff = Date.now() - ts
  const days = Math.floor(diff / (1000 * 60 * 60 * 24)) + 1
  return Math.max(1, days)
}

export function WelcomeModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'welcome')
  const closeModal = useUiStore((s) => s.closeModal)
  const preferences = useProjectsStore((s) => s.preferences)
  const displayName = preferences.displayName
  const firstLaunchAt = useProjectsStore((s) => s.preferences.firstLaunchAt)

  const days = useMemo(() => daysSince(firstLaunchAt), [firstLaunchAt])
  const initial = getProfileInitial(displayName)
  const avatarUrl = getProfileImageUrl(preferences)
  const [imgFailed, setImgFailed] = useState(false)

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && open && closeModal()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <Dialog.Close asChild>
            <button type="button" aria-label={t('common.close')} className={styles.close}>
              <X size={16} />
            </button>
          </Dialog.Close>

          <div className={styles.body}>
            <div className={styles.avatarWrap}>
              {!avatarUrl || imgFailed ? (
                <div className={styles.avatarFallback}>{initial}</div>
              ) : (
                <img
                  className={styles.avatar}
                  src={avatarUrl}
                  alt={t('welcome.photoAlt', { name: displayName })}
                  onError={() => setImgFailed(true)}
                />
              )}
            </div>

            <div className={styles.eyebrow}>
              {t('welcome.dayCount', { days, product: PRODUCT_NAME })}
            </div>

            <Dialog.Title className={styles.title}>
              {t('welcome.greeting', { name: displayName })}
            </Dialog.Title>

            <p className={styles.subtitle}>{t('welcome.subtitle')}</p>

            {/* "Skip" and "Start" both just closed the dialog, promising two
                outcomes that were the same one. The × already covers dismissal. */}
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={closeModal}>
                {t('common.start')}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
