import { newSong } from './song'
import { t } from '../i18n/en'

export function demoSong() {
    return {
        ...newSong(),
        title: t('demoTitle'),
        artist: t('demoArtist'),
        lyrics: '[section=Verse]\nA little more light on the road ahead\nA little more room for the words unsaid\n[line bars=2] We have all the time we need tonight\n\n[section=Chorus]\n[tempo=80%]\nLet the melody carry us home\nLet the quiet remind us we are not alone\n[/tempo]\n[pause beats=4]\nOne last line, one little more light',
    }
}
