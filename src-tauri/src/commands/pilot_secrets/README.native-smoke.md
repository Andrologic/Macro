# Smoke macOS du coffre synthétique

Ce test opt-in exerce les fonctions `read`, `write` et `delete` du véritable
adaptateur dans `macos.rs`. Il utilise un trousseau jetable et des credentials
synthétiques. Il ne teste ni le parcours interactif ni les notifications OS.

Depuis la racine du dépôt, sur macOS avec le SDK et le target Rust existants :

```sh
MACRO_PILOT_NATIVE_SMOKE=1 CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 \
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' \
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib \
commands::pilot_secrets::native::macos::native_smoke::isolated_native_silent_smoke \
-- --ignored --exact \
--test-threads=1 --nocapture
```

Le test est ignoré par les suites ordinaires et exige la variable égale à `1`.

## Isolation et nettoyage

Le test crée un répertoire exclusif avec `tempfile`, puis appelle
`SecKeychainCreate` avec un mot de passe synthétique explicite,
`promptUser=false` et `initialAccess=NULL`. Une référence non nulle et un chemin
contenu dans ce répertoire sont vérifiés. Les opérations de fixture et celles
de l'adaptateur utilisent le même mutex et la même politique d'interaction
silencieuse, avec restauration de la valeur antérieure.

Une injection locale au thread, compilée seulement avec `cfg(test)`, remplace
la résolution du coffre par défaut par cette référence retenue. En mode smoke,
une injection absente fait échouer l'adaptateur avant cette résolution.
Les appels interactifs sont également refusés dans ce mode. Aucun mot de passe
réel, certificat, règle d'ACL ou coffre personnel n'est consulté ou modifié.

La création peut avoir des effets sur la liste de recherche selon le système.
Le test ne remplace jamais cette liste et n'appelle pas SetDefault.
La suppression utilise seulement `SecKeychainDelete` avec la référence créée.
Elle vérifie ensuite l'absence de cette référence dans CopySearchList, sans
consulter les credentials ni les chemins des autres entrées. La liste opaque
est comparée à celle relevée avant création ; une différence fait échouer le
test, sans restauration globale. Le répertoire
doit être vide avant `remove_dir`. Tout résidu fait échouer le test et son
répertoire est signalé ; aucune suppression récursive ne masque ce résidu.
Le nettoyage s'exécute aussi après une assertion en échec. Un arrêt brutal du
processus peut empêcher ce nettoyage et nécessite d'examiner le résidu signalé.

## Preuves et limites

Le scénario vérifie création d'un secret, lecture, mise à jour, suppression,
absence et suppression idempotente. Il prépare ensuite un élément, verrouille
uniquement le trousseau synthétique, puis tente lecture, écriture et suppression
silencieuses. Lecture et écriture doivent renvoyer `-25308`, `-25315` ou
`-25293`. Ce dernier reste `vault_unavailable` dans le contrat, sans cause
supposée. Toute autre erreur échoue, les étapes sur coffre déverrouillé exigent
un succès. Une suppression verrouillée peut réussir ou renvoyer un de ces
statuts ; son résultat est
vérifié après déverrouillage avec le mot de passe synthétique explicite.

Le temps observé du lot verrouillé doit rester inférieur à cinq secondes.
Cette assertion ne constitue pas une interruption d'un service OS bloqué.
Les journaux exposent opérations, durées, statuts numériques et résultats
contrôlés, jamais les valeurs des mots de passe ou des credentials.

Un succès prouve ces opérations réelles dans le coffre synthétique de cette
exécution. Il ne prouve pas le comportement d'ACL personnelles ou refusées,
la persistance d'une autorisation entre deux signatures, le parcours interactif,
la livraison des hooks de veille/verrouillage, ni les plateformes Windows/Linux.

## Sources consultées avant exécution

- Headers SDK `Security.framework/Headers/SecKeychain.h` : signatures, paramètres
  explicites, suppression ciblée et libération des références.
- [Apple, SecKeychainCreate](https://developer.apple.com/documentation/security/seckeychaincreate(_:_:_:_:_:_:)) : mot de passe explicite et contrôle du dialogue.
- [Apple, SecKeychainDelete](https://developer.apple.com/documentation/security/seckeychaindelete(_:)) : retrait ciblé de la liste et suppression du fichier.
- [Apple Security, StorageManager.cpp](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/StorageManager.cpp) : `shouldAddToSearchList` et `created` montrent que les chemins login/System ont des effets particuliers, dont un choix de défaut si aucun n'existe. Le test refuse ces formes de chemin et ne dépend pas d'une absence universelle d'ajout à la liste.
