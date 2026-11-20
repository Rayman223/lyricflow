# Format musical — version 1

Contrat utilisé par l’éditeur et le moteur, indépendant de la largeur d’écran. Les morceaux locaux portent `formatVersion: 1`. L’extension `beats` et les blocs `line` conservent cette version : les structures persistantes et le contenu JSON restent identiques, sans migration SQL ni IndexedDB. Les lectures privées passent par le parseur, qui refuse les codes inconnus. Pour les liens publics, le lecteur annonce la capacité `line-timing` dans l’en-tête `X-LyricFlow-Capabilities` ; le serveur refuse avec HTTP 409 (`client_update_required`, sans contenu musical) les morceaux utilisant `beats` sur une ligne ou un bloc `line` si cette capacité manque. Les morceaux en ancienne syntaxe restent accessibles sans cet en-tête. La capacité ne change aucune permission et la visibilité publique est vérifiée avant ce contrôle. Toute évolution incompatible devra conserver un lecteur du format précédent ou fournir sa migration, sans réinterprétation silencieuse des paroles.

Une ligne écrite correspond à une étape musicale. Les retours visuels sur téléphone ne la divisent pas. Les lignes vides et les titres de section ne prennent aucun temps. Une attente doit être explicite.

```text
[section=Verse]
A line at the song tempo
[line bars=1.5] A longer line
[line tempo=80 bars=2] Two bars at 80 BPM
[line tempo=80%] A line following the song BPM

[tempo=90]
A passage at a fixed tempo
Another line in this passage
[/tempo]

[tempo=80%]
A passage relative to the song BPM
[/tempo]

[line beats=6] Six beats regardless of beats per bar

[line tempo=80% beats=4]
Each line lasts four beats
At 80% of the song BPM
[line bars=2] Two bars instead of four beats
[/line]

[pause beats=8]
[pause bars=4]
[pause seconds=5]
```

- Codes sensibles à la casse, mots-clés anglais, décimales avec un point. Ils commencent en début de ligne, après d’éventuels espaces.
- Les codes de section, bloc et pause occupent leur propre ligne. Un code `[line …]` suivi de paroles concerne cette ligne ; seul sur sa ligne, il ouvre un bloc fermé par `[/line]`.
- Priorité : réglage de ligne, puis bloc, puis morceau. La durée du bloc s’applique à chaque ligne de paroles, pas au passage entier. Une durée locale remplace entièrement celle du bloc, quelle que soit son unité ; un tempo local seul conserve la durée héritée. Les pauses héritent uniquement du tempo et gardent leur propre durée. Aucun bloc `line` ou `tempo` ne peut en contenir un autre ; la fermeture doit correspondre au type ouvert et rétablit les réglages du morceau.
- Un pourcentage se réfère toujours au BPM du morceau. Un BPM absolu reste fixe lorsque celui-ci change.
- `tempo`, `bars` et `beats` sont les seuls paramètres de ligne et de bloc `line`. `bars` et `beats` sont mutuellement exclusifs. Chacun apparaît au plus une fois, dans n’importe quel ordre ; au moins un est requis.
- Échappement : `\[` en début de ligne affiche un `[` littéral. `\\` affiche un antislash ; `\]` affiche `]`. Aucune interprétation HTML.
- Les erreurs indiquent leur ligne source. Elles empêchent la lecture, mais pas l’enregistrement du brouillon.

## Bornes techniques

| Champ | Valeurs acceptées |
| --- | --- |
| BPM du morceau | 1 à 1000 |
| Temps par mesure | Entier de 1 à 32 |
| Mesures par ligne, par code ou par défaut | 0.01 à 1000 |
| Tempo dans un code | 0.01 à 1000 BPM, ou 0.01 à 1000 % |
| Temps par ligne ou par bloc `line` (`beats`) | 0.01 à 1000 |
| Pause en temps ou mesures | 0.01 à 1000 |
| Pause en secondes | 0.01 à 86400 |
| Vitesse visuelle | 1 à 1000 pixels CSS/seconde |
| Décompte | Entier de 0 à 32 temps ; 0 le désactive |
| Taille de texte | 18 à 80 pixels CSS |
| Titre / artiste | 200 caractères chacun |
| Paroles et codes | 100 000 caractères |

Une durée musicale vaut `mesures × tempsParMesure × 60 / BPMEffectif`. Une durée explicite en temps vaut `beats × 60 / BPMEffectif`, indépendamment du nombre de temps par mesure. Les mesures et temps fractionnaires sont pris en charge.

## Lecture et changements en cours de route

L’horloge utilise `performance.now()`. Le moteur conserve des temps musicaux restants, ou des secondes pour une pause absolue, ou des pixels pour un déplacement visuel. Un changement de BPM consomme d’abord le temps écoulé à l’ancien BPM, puis applique le nouveau rythme uniquement au temps restant. Les pauses en secondes restent inchangées.

En mode pixels/seconde, les distances sont mesurées entre les débuts des lignes logiques dans la mise en page réelle. Les sections intermédiaires font partie de la distance ; elles n’ajoutent aucune attente musicale. Les codes de tempo servent uniquement aux pauses musicales. Une pause arrête le mouvement, puis celui-ci reprend à la vitesse visuelle choisie.

Le décompte suit le BPM effectif du premier passage, y compris si un code absolu ou relatif s’applique dès le début. L’initialisation sonore ne bloque jamais le décompte visuel ni le lancement du lecteur.

Le recalage tactile recommence la ligne entière avec son contexte de bloc déjà calculé. Il conserve l’état en marche ou en pause. Un passage en arrière-plan met le lecteur en pause ; le retour requiert une reprise manuelle, sans rattrapage. La rotation, la taille du texte et le changement de ligne active déclenchent une nouvelle mesure sans diviser les paroles ni réinitialiser le temps musical. En défilement continu, une pause conserve la position de la prochaine ligne de paroles afin de reprendre sans saut au-delà des marqueurs de pause ou de section.
