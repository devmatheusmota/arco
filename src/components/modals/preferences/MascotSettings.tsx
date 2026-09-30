import { BUNDLED_PETS } from '../../../components/MascotOverlay/pets'
import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import { ImageInput } from '../ImageInput'
import styles from '../PreferencesModal.module.css'

export function MascotSettings() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)

  return (
    <div className={styles.mascotSection}>
      <span className={styles.mascotLabel}>{t('mascot.pick')}</span>
      <div className={styles.mascotPicker}>
        {BUNDLED_PETS.map((pet) => (
          <button
            key={pet.id}
            type="button"
            className={preferences.mascotPet === pet.id ? styles.mascotOptionActive : undefined}
            onClick={() => setPreferences({ mascotPet: pet.id })}
            aria-pressed={preferences.mascotPet === pet.id}
          >
            <img src={pet.url} alt="" draggable={false} />
            <span>{pet.label}</span>
          </button>
        ))}
        {preferences.mascotCustomImage ? (
          <button
            type="button"
            className={preferences.mascotPet === 'custom' ? styles.mascotOptionActive : undefined}
            onClick={() => setPreferences({ mascotPet: 'custom' })}
            aria-pressed={preferences.mascotPet === 'custom'}
          >
            <img src={preferences.mascotCustomImage} alt="" draggable={false} />
            <span>{t('mascot.custom')}</span>
          </button>
        ) : null}
      </div>
      <ImageInput
        label={t('mascot.customLabel')}
        value={preferences.mascotCustomImage}
        onChange={(value) =>
          setPreferences({
            mascotCustomImage: value,
            // Uploading switches to the new image; clearing falls back to the default.
            mascotPet: value ? 'custom' : 'claudino',
          })
        }
        hint={t('mascot.customHint')}
      />
    </div>
  )
}
