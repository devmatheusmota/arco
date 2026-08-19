import { FolderArchive } from 'lucide-react'
import { useMemo } from 'react'

import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import styles from '../PreferencesModal.module.css'

export function OrganizationPage() {
  const t = useT()
  const allProjects = useProjectsStore((state) => state.projects)
  const unarchiveProject = useProjectsStore((state) => state.unarchiveProject)
  const archivedProjects = useMemo(
    () => allProjects.filter((project) => project.archived),
    [allProjects],
  )

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeading}>
        <h2>{t('prefs.archivedProjectsTitle')}</h2>
        <p>{t('prefs.archivedProjectsDesc')}</p>
      </div>
      {archivedProjects.length === 0 ? (
        <div className={styles.emptyState}>{t('prefs.archivedProjectsEmpty')}</div>
      ) : (
        <div className={styles.optionList}>
          {archivedProjects.map((project) => (
            <div key={project.id} className={styles.optionRow}>
              <div className={styles.optionCopy}>
                <strong>{project.name}</strong>
                <span>
                  {t('prefs.archivedProjectTerminals', { count: project.terminals.length })}
                </span>
              </div>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => unarchiveProject(project.id)}
              >
                <FolderArchive size={14} />
                {t('prefs.restoreProject')}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
