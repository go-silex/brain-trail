import type { Lang } from '../types/model'

// a name in quotes, and the first few of a list
const q = (s: string | undefined) => `« ${s ?? ''} »`
const few = (x: string[]) => (x.length <= 3 ? x.map(q).join(', ') : `${x.slice(0, 3).map(q).join(', ')} +${x.length - 3}`)

const en = {
  brand: 'Unkillable Companies',
  enlargePane: 'Enlarge the pane to show Brain Trail.',
  bodyPages: { first: 'First page', previous: 'Previous page', next: 'Next page', last: 'Last page' },
  tagline: 'AI works better with the right context.', site: 'unkillablecompanies.com', madeBy: 'Made by',
  zoneLabel: { ok: 'Room to spare', warn: 'Compact soon', bad: 'Change session' },
  tabs: { map: 'Map', goal: 'Goal', coach: 'Coach', files: 'Files', context: 'Context', handoff: 'Hand-off' },
  goalNow: 'Current goal', noGoal: 'No goal yet: ask Claude something.',
  workingFor: (d: string) => `Working for ${d}`, doneIn: (d: string) => `Done in ${d}`,
  lessMin: 'under a minute', mins: (m: number) => `${m} min`, actionsN: (n: number) => `${n} action${n > 1 ? 's' : ''}`,
  planOfClaude: "Claude's plan", whatClaudeDid: 'What Claude did', thinking: 'Claude is thinking about how to go about it…', noAction: 'Claude answered without any action.',
  earlierGoals: 'Earlier goals', history: 'History',
  g: {
    read: (x: string[]) => (x.length <= 1 ? `Reads ${q(x[0])}` : `Reads ${x.length} documents: ${few(x)}`),
    write: (x: string[]) => (x.length <= 1 ? `Writes ${q(x[0])}` : `Writes ${x.length} documents: ${few(x)}`),
    edit: (x: string[]) => (x.length <= 1 ? `Updates ${q(x[0])}` : `Updates ${x.length} documents: ${few(x)}`),
    search: (x: string[]) => `Searches the documents for ${few(x)}`,
    run: (x: string[]) => (x.length <= 1 ? `Runs a step: ${x[0] ?? ''}` : `Runs ${x.length} steps: ${x.slice(0, 3).join('; ')}`),
    web: (x: string[]) => `Reads web pages: ${few(x)}`,
    websearch: (x: string[]) => `Searches the web for ${few(x)}`,
    agent: (x: string[]) => `Hands a task to an assistant: ${x.join('; ')}`,
    skill: (x: string[]) => `Applies the method ${few(x)}`,
    ask: (x: string[]) => `Asks you a question: ${x[0] ?? ''}`,
    service: (svc: string, verb: string, x: string[]) => `${{ look: 'Looks up', add: 'Adds to', update: 'Updates', send: 'Sends through', remove: 'Removes from', use: 'Uses' }[verb] ?? 'Uses'} ${svc}${x.length ? `: ${x.slice(0, 3).join('; ')}` : ''}`,
    other: (x: string[]) => `Uses the tool ${x[0] ?? ''}`,
    byAgent: (t: string) => `An assistant ${t.charAt(0).toLowerCase()}${t.slice(1)}`,
  },

  bandContext: (p: number) => `Context ${p} %`, bandCost: (u: string) => `session ${u}`,
  bandSetting: 'Band above the prompt', bandWhy: 'The context and the cost of the session, always in sight, even with the pane closed.',
  notes: 'notes', current: 'Current file', lastCall: 'Last call',
  replay: 'Replay', resume: 'Resume', pause: 'Pause', live: 'Live',
  stepsLive: (n: number) => `${n} steps`, stepOf: (i: number, n: number) => `Step ${i} of ${n}`,
  outsideN: (n: number) => `${n} file${n > 1 ? 's' : ''} outside this folder`, badgeStart: 'loaded at start', badgeSeen: 'seen in a search', back: 'Back', openIn: (a: string) => `Open in ${a}`, openElsewhere: 'Open with its app', cannotRead: 'This file cannot be read.', previewApp: 'Preview in Brain Trail',
  previewLoading: 'Loading file…', appsUnavailable: 'App discovery is unavailable. Previously discovered apps may be shown.',
  mapEmpty: 'The files Claude reads will light up here.',
  planUse: 'Your Claude plan', limit5h: 'Session (5 hours)', limit7d: 'Week (7 days)', resetsAt: (w: string) => `Resets ${w}`, usedPct: (p: number) => `${p} % used`,
  band5h: (p: number) => `5 h ${p} %`, band7d: (p: number) => `week ${p} %`,
  whatISee: 'What I notice', noTip: 'Nothing to point out yet: the tips come as the session goes on.',
  tipBigRead: (f: string, _t: string) => ({ title: `${f} was read from start to end`, body: 'Part of it would have done. Say which section matters to you: Claude stays focused on what you asked.' }),
  tipReread: (f: string, n: number) => ({ title: `${f} was opened ${n} times`, body: 'Claude keeps going back for the same information. Write the essentials once in your company context file, so it has them from the start.' }),
  tipSearch: (n: number) => ({ title: `Claude searched ${n} times before finding`, body: 'It did not know where your information lives. Describe in your company context file where your offers, clients and decisions are.' }),
  tipShort: (p: string, n: number) => ({ title: `« ${p} » left Claude guessing`, body: `A short request made it take ${n} steps to understand. Say the result you expect, who it is for, and which documents to start from.` }),
  tipLinks: (n: number) => ({ title: `${n} notes used together are not linked`, body: 'Link them: next time Claude will find its way straight away.' }),
  tipMcp: (s: number, u: number, _t: string) => ({ title: `${s} connected tools, ${u} used`, body: 'Every connected tool weighs on every exchange. Keep the ones your daily work needs.' }),
  tipMemory: (_t: string) => ({ title: 'Your company context file is very long', body: 'Claude reads it at every exchange. Keep what helps it decide, and move the detail into separate documents.' }),
  tipWindow: (p: number) => ({ title: `This conversation is ${p} % full`, body: 'Past half, Claude gets less precise. Finish the current topic, then start a new conversation.' }),
  coachTitle: 'Coaching on this session', coachWhy: 'Claude reads this conversation again as a business coach would: how to ask for what you need, and what it should know about your company.',
  coachRun: 'Analyse my session', coachAgain: 'Analyse again', coachBusy: 'Analysing…', coachFailed: 'The analysis could not be done:', coachEmpty: 'Nothing to analyse yet: the session has no exchange.',
  toAdd: (f: string) => `To add to ${f}`, applyWith: (f: string) => `Apply to ${f} with Claude`, applyHow: 'The request lands in your prompt box. Read it, then press Enter: Claude makes the change and shows it.',
  applyPrompt: (f: string, p: string) => `Add these lines to ${f}, where they fit, without repeating what is already there, then show me the change:\n\n${p}`,
  applyReady: 'The request is in your prompt box: press Enter to send it.', applyFailed: 'The prompt box could not take the request.',
  academyTitle: 'Learn to build a good company context', academyWhy: 'The Unkillable Academy teaches how to give Claude the context of your company, so every session starts on the right foot.', academyLink: 'academy.unkillablecompanies.com',
  unfollow: 'Stop following', whatToDo: 'What to do now', trailCard: 'Trail', clearWhy: 'Clears the map and the replay of this session. Nothing is deleted from your files.',
  moreDetails: 'More details', lessDetails: 'Fewer details',
  costTitle: 'Cost of this session',
  costWhat: 'What this session would cost if it were billed at API prices.',
  costNone: 'No cost reading yet: it appears after the first answer.',
  verdictWait: (n: number) => `Not enough past sessions to compare yet (${n} of 3).`,
  verdictLight: (r: number) => `Light: ${r.toFixed(1)} times your usual session.`,
  verdictUsual: 'In line with your usual sessions.',
  verdictHeavy: (r: number) => `Heavy: ${r.toFixed(1)} times your usual session.`,
  perRequest: (u: string, n: number) => `${u} per request on average (${n} requests).`,
  thisMonth: (u: string) => `${u} in API value this month, across the sessions Brain Trail saw.`,
  saved: (u: string, plan: string) => `Your plan (${plan} a month) saved you ${u} this month.`,
  notYet: (u: string, plan: string) => `Your plan (${plan} a month) costs ${u} more than your API usage this month.`,
  planHint: 'Enter your plan price in Settings to see what you save.',
  costHow: 'The figure is the one /cost gives: tokens counted by the engine, at API prices. Your usual session is the median of the past sessions Brain Trail saw.',
  planTitle: 'Your Claude plan', planWhy: 'Its monthly price, in dollars, to compare with the API value of your sessions.', planPlaceholder: 'e.g. 100', save: 'Save',
  open3d: '3D', open3dFailed: 'The 3D view could not open in the browser.', open3dBig: '⤢ Full screen',
  follow: 'Follow Claude', openLine: 'Open:', mapHelp: 'Left-click a note to open it. Left-drag moves in 2D or turns in 3D; right-drag moves. Middle-drag zooms; the wheel zooms when the host supplies it.', subfolder: 'Sub-folder…',
  settings: 'Settings', openWith: 'Open files with', openWithWhy: 'The app a click on a file name opens it in.',
  openMd: 'Markdown notes (.md)', openOther: 'Other files', defaultApp: 'System default',
  display: 'Display', language: 'Language', hoverNames: 'File names on hover', hoverWhy: 'On the map, hovering a dot shows the name of its file.',
  on: 'On', off: 'Off',

  files: 'files',
  // map
  whole: 'See all', trail: 'Trail',
  mapOnlyDesktop: 'The map is drawn in the desktop app only.',
  packing: (s: number) => `Packing the folder into one disc${s > 2 ? ` (${s} s)` : ''}…`,
  packFailed: 'The folder could not be listed:',
  retry: 'Try again',
  legend: 'Solid dot: read. Ringed dot: written. Faint dot: name seen in a search. Blue dot: the file Claude is on. Dashes: a jump between two notes with no link. Around: the outside services called, with their count.',
  figRead: 'files read', figWritten: 'written', figFound: 'found by search', figGap: 'jumps with no link', figCalls: 'MCP calls',
  lastSteps: 'Last steps', noStep: 'No file touched yet. Ask Claude something.',
  subAgent: 'sub-agent',
  // files
  filesIntro: 'Files of this session, by folder',
  gStart: 'Loaded before your first message',
  gStartWhy: 'Instruction and memory files (CLAUDE.md, AGENTS.md, their @imports, auto memory). Claude reads them at every request.',
  gRead: 'Read', gReadWhy: 'Opened by Claude. Their content is in the context until the next compaction.',
  gWritten: 'Written', gWrittenWhy: 'Created or changed by Claude. The edit itself is in the context.',
  gFound: 'Seen in a result', gFoundWhy: 'Named by a search, a listing, a connector or a sub-agent\'s report. Only their name (and the matching line) entered the context, not the file.',
  gLinked: 'Seen through a link', gLinkedWhy: 'Linked from a note Claude read. Their name came in with that note; Claude can follow the link.',
  lgRead: 'read', lgWrite: 'written', lgFound: 'seen in a result', lgLinked: 'seen through a link', lgGap: 'jump with no link',
  wheelHint: 'Wheel over the map: zoom.',
  homeRoot: 'This session runs in your home folder. The map shows its first levels only: start the session in a project or vault folder to see it whole.',
  gAgent: 'Read by a sub-agent', gAgentWhy: 'A sub-agent read them in its own context. Only its summary came back here.',
  outside: 'outside this folder',
  times: (r: number, w: number) => [r > 0 ? `read ×${r}` : '', w > 0 ? `written ×${w}` : ''].filter(Boolean).join(' · '),
  noFiles: 'Nothing yet.',
  kpiRead: (n: number) => `read ${n}×`, kpiWrite: (n: number) => `written ${n}×`, kpiTokens: (t: string) => `≈${t} tokens`, kpiEmpty: 'No file here in this session.',
  missing: 'Missing links',
  missingWhy: 'Notes Claude chained with no link between them. Adding the link helps the next session find its way.',
  then: 'then',
  copy: 'Copy', copied: 'Copied', open: 'Open',
  // context
  window: 'Context window',
  ofTokens: (t: string, w: string) => `${t} of ${w} tokens`,
  noReading: 'No reading yet: the gauge fills after the first answer.',
  compactAt: (p: number) => `Auto-compaction at ${p}%`,
  compactOff: 'Auto-compaction is off',
  zone: {
    ok: 'Plenty of room. Keep going.',
    warn: 'Past half the window, answers start to lose precision. Finish the current task, then compact with a focus.',
    bad: 'The window is nearly full. Start a new session with a hand-off, or compact now.',
  },
  compactNow: 'Compact now', toHandoff: 'Prepare a hand-off',
  compactBusy: 'Claude is working. Compact once the turn ends.',
  compactDone: 'Compacted.',
  startTitle: 'Loaded before your first message',
  startWhy: 'Claude carries all of this before you type anything, and pays for it on every request.',
  memory: 'Instruction and memory files', mcp: 'MCP tools', skills: 'Skills', agents: 'Custom agents',
  mcpLine: (s: number, t: number) => `${s} servers, ${t} tools`,
  skillsLine: (n: number, of: number) => `${n} listed of ${of}`,
  deferred: 'loaded on demand',
  eaters: 'What fills it',
  eatersWhy: 'The tool results that took the most room since the last compaction (estimate).',
  noEaters: 'No tool result yet.',
  tip: {
    Read: 'Read a range (offset and limit) or search inside the file first.',
    Bash: 'Pipe long output through head, tail or grep.',
    Grep: 'Narrow the search with a glob, or list file names only.',
    Glob: 'Narrow the pattern.',
    WebFetch: 'Ask for a summary, or hand it to a sub-agent.',
    Agent: 'That is the sub-agent summary: its own reads stayed out.',
    mcp: 'Ask the service for fewer fields or a smaller page.',
    other: 'Hand big reads to a sub-agent: only its summary comes back.',
  },
  categories: 'Breakdown',
  // hand-off
  hoTitle: 'Change session without losing the thread',
  hoWhy: 'A new session starts with an empty window. This brief carries over what matters: the goal, what is done, the decisions, the files, the next step.',
  hoWhen: 'Compact when you stay on the same task. Start a new session when the task changes or the window is past 75%.',
  hoWrite: 'Write the hand-off', hoBusy: 'Writing…', hoAgain: 'Write it again',
  hoPaste: 'Copy it, open a new session, paste it as your first message.',
  hoFailed: 'The hand-off could not be written:',
  hoEmpty: 'Nothing to hand off yet: the session has no exchange.',
  // footer
  clear: 'Clear trail', lang: 'Français',
  opened: 'Brain Trail opened.', later: 'Brain Trail opens once the app is attached to the session.',
  toastWarn: 'Context past 50%. Brain Trail: think about compacting.',
  toastBad: 'Context past 75%. Brain Trail: hand off to a new session.',
}

type Strings = typeof en

const fr: Strings = {
  brand: 'Unkillable Companies',
  enlargePane: 'Agrandissez le panneau pour afficher Brain Trail.',
  bodyPages: { first: 'Première page', previous: 'Page précédente', next: 'Page suivante', last: 'Dernière page' },
  tagline: 'AI works better with the right context.', site: 'unkillablecompanies.com', madeBy: 'Une création',
  zoneLabel: { ok: 'De la marge', warn: 'Compacter bientôt', bad: 'Changer de session' },
  tabs: { map: 'Carte', goal: 'Objectif', coach: 'Coach', files: 'Fichiers', context: 'Contexte', handoff: 'Passation' },
  goalNow: 'Objectif en cours', noGoal: "Pas encore d'objectif : pose une question à Claude.",
  workingFor: (d: string) => `En cours depuis ${d}`, doneIn: (d: string) => `Terminé en ${d}`,
  lessMin: "moins d'une minute", mins: (m: number) => `${m} min`, actionsN: (n: number) => `${n} action${n > 1 ? 's' : ''}`,
  planOfClaude: 'Plan de Claude', whatClaudeDid: 'Ce que Claude a fait', thinking: 'Claude réfléchit à la façon de s\'y prendre…', noAction: 'Claude a répondu sans rien faire de plus.',
  earlierGoals: 'Objectifs précédents', history: 'Historique',
  g: {
    read: (x: string[]) => (x.length <= 1 ? `Lit ${q(x[0])}` : `Lit ${x.length} documents : ${few(x)}`),
    write: (x: string[]) => (x.length <= 1 ? `Rédige ${q(x[0])}` : `Rédige ${x.length} documents : ${few(x)}`),
    edit: (x: string[]) => (x.length <= 1 ? `Met à jour ${q(x[0])}` : `Met à jour ${x.length} documents : ${few(x)}`),
    search: (x: string[]) => `Cherche dans les documents : ${few(x)}`,
    run: (x: string[]) => (x.length <= 1 ? `Exécute une étape : ${x[0] ?? ''}` : `Exécute ${x.length} étapes : ${x.slice(0, 3).join(' ; ')}`),
    web: (x: string[]) => `Lit des pages web : ${few(x)}`,
    websearch: (x: string[]) => `Cherche sur le web : ${few(x)}`,
    agent: (x: string[]) => `Confie une tâche à un assistant : ${x.join(' ; ')}`,
    skill: (x: string[]) => `Applique la méthode ${few(x)}`,
    ask: (x: string[]) => `Te pose une question : ${x[0] ?? ''}`,
    service: (svc: string, verb: string, x: string[]) => `${{ look: 'Consulte', add: 'Ajoute dans', update: 'Met à jour', send: 'Envoie via', remove: 'Supprime dans', use: 'Utilise' }[verb] ?? 'Utilise'} ${svc}${x.length ? ` : ${x.slice(0, 3).join(' ; ')}` : ''}`,
    other: (x: string[]) => `Utilise l'outil ${x[0] ?? ''}`,
    byAgent: (t: string) => `Un assistant ${t.charAt(0).toLowerCase()}${t.slice(1)}`,
  },

  bandContext: (p: number) => `Contexte ${p} %`, bandCost: (u: string) => `session ${u}`,
  bandSetting: 'Bandeau au-dessus de la saisie', bandWhy: 'Le contexte et le coût de la session, toujours visibles, même pane fermé.',
  notes: 'notes', current: 'Fichier en cours', lastCall: 'Dernier appel',
  replay: 'Rejouer', resume: 'Reprendre', pause: 'Pause', live: 'Direct',
  stepsLive: (n: number) => `${n} étapes`, stepOf: (i: number, n: number) => `Étape ${i} sur ${n}`,
  outsideN: (n: number) => `${n} fichier${n > 1 ? 's' : ''} hors de ce dossier`, badgeStart: 'chargé au départ', badgeSeen: 'vu en recherche', back: 'Retour', openIn: (a: string) => `Ouvrir dans ${a}`, openElsewhere: 'Ouvrir avec son app', cannotRead: 'Impossible de lire ce fichier.', previewApp: 'Aperçu dans Brain Trail',
  previewLoading: 'Chargement du fichier…', appsUnavailable: "La recherche d’applications est indisponible. Les applications déjà découvertes peuvent être affichées.",
  mapEmpty: 'Les fichiers que Claude lit s\'allumeront ici.',
  planUse: 'Ton forfait Claude', limit5h: 'Session (5 heures)', limit7d: 'Semaine (7 jours)', resetsAt: (w: string) => `Remise à zéro ${w}`, usedPct: (p: number) => `${p} % utilisés`,
  band5h: (p: number) => `5 h ${p} %`, band7d: (p: number) => `semaine ${p} %`,
  whatISee: 'Ce que je remarque', noTip: 'Rien à signaler pour le moment : les conseils viennent au fil de la session.',
  tipBigRead: (f: string, _t: string) => ({ title: `${f} a été lu du début à la fin`, body: 'Une partie aurait suffi. Dis quelle section t\'intéresse : Claude reste concentré sur ta demande.' }),
  tipReread: (f: string, n: number) => ({ title: `${f} a été ouvert ${n} fois`, body: 'Claude revient chercher la même information. Écris l\'essentiel une fois dans le fichier de contexte de ton entreprise, pour qu\'il l\'ait d\'emblée.' }),
  tipSearch: (n: number) => ({ title: `Claude a cherché ${n} fois avant de trouver`, body: 'Il ne savait pas où sont tes informations. Décris dans ton fichier de contexte où se trouvent tes offres, tes clients et tes décisions.' }),
  tipShort: (p: string, n: number) => ({ title: `« ${p} » a laissé Claude deviner`, body: `Une demande courte l\'a obligé à faire ${n} étapes pour comprendre. Dis le résultat attendu, pour qui, et à partir de quels documents.` }),
  tipLinks: (n: number) => ({ title: `${n} notes utilisées ensemble ne sont pas reliées`, body: 'Relie-les : la prochaine fois, Claude trouvera le chemin directement.' }),
  tipMcp: (s: number, u: number, _t: string) => ({ title: `${s} outils connectés, ${u} utilisés`, body: 'Chaque outil connecté alourdit chaque échange. Garde ceux dont ton métier a besoin au quotidien.' }),
  tipMemory: (_t: string) => ({ title: 'Le fichier de contexte de ton entreprise est très long', body: 'Claude le relit à chaque échange. Garde ce qui l\'aide à décider, range le détail dans des documents à part.' }),
  tipWindow: (p: number) => ({ title: `Cette conversation est chargée à ${p} %`, body: 'Au-delà de la moitié, Claude devient moins précis. Termine le sujet en cours, puis repars sur une nouvelle conversation.' }),
  coachTitle: 'Coaching sur cette session', coachWhy: 'Claude relit la conversation comme le ferait un coach métier : comment demander ce dont tu as besoin, et ce qu\'il devrait savoir de ton entreprise.',
  coachRun: 'Analyser ma session', coachAgain: 'Relancer l\'analyse', coachBusy: 'Analyse en cours…', coachFailed: 'L\'analyse n\'a pas pu être faite :', coachEmpty: 'Rien à analyser : la session n\'a pas encore d\'échange.',
  toAdd: (f: string) => `À ajouter à ${f}`, applyWith: (f: string) => `Appliquer dans ${f} avec Claude`, applyHow: 'La demande arrive dans ta zone de saisie. Relis-la, puis appuie sur Entrée : Claude fait la modification et te la montre.',
  applyPrompt: (f: string, p: string) => `Ajoute ces lignes à ${f}, à l'endroit qui convient, sans répéter ce qui y est déjà, puis montre-moi le changement :\n\n${p}`,
  applyReady: 'La demande est dans ta zone de saisie : appuie sur Entrée pour l\'envoyer.', applyFailed: 'La zone de saisie n\'a pas pu recevoir la demande.',
  academyTitle: 'Apprendre à créer un bon contexte d\'entreprise', academyWhy: 'L\'Unkillable Academy apprend à donner à Claude le contexte de ton entreprise, pour que chaque session parte du bon pied.', academyLink: 'academy.unkillablecompanies.com',
  unfollow: 'Ne plus suivre', whatToDo: 'Que faire maintenant', trailCard: 'Parcours', clearWhy: 'Efface la carte et la lecture de cette session. Rien n\'est supprimé dans tes fichiers.',
  moreDetails: 'Plus de détails', lessDetails: 'Moins de détails',
  costTitle: 'Coût de la session',
  costWhat: "Ce que cette session coûterait si elle était facturée au prix de l'API.",
  costNone: 'Pas encore de coût : il apparaît après la première réponse.',
  verdictWait: (n: number) => `Pas encore assez de sessions passées pour comparer (${n} sur 3).`,
  verdictLight: (r: number) => `Sobre : ${r.toFixed(1).replace('.', ',')} fois ta session habituelle.`,
  verdictUsual: 'Dans la moyenne de tes sessions.',
  verdictHeavy: (r: number) => `Gourmande : ${r.toFixed(1).replace('.', ',')} fois ta session habituelle.`,
  perRequest: (u: string, n: number) => `${u} par demande en moyenne (${n} demandes).`,
  thisMonth: (u: string) => `${u} en valeur API ce mois-ci, sur les sessions vues par Brain Trail.`,
  saved: (u: string, plan: string) => `Ton abonnement (${plan} par mois) t'a fait économiser ${u} ce mois-ci.`,
  notYet: (u: string, plan: string) => `Ton abonnement (${plan} par mois) coûte ${u} de plus que ton usage API ce mois-ci.`,
  planHint: "Renseigne le prix de ton abonnement dans les Réglages pour voir ce que tu économises.",
  costHow: "Le chiffre est celui de /cost : les tokens comptés par le moteur, au prix de l'API. Ta session habituelle est la médiane des sessions passées vues par Brain Trail.",
  planTitle: 'Ton abonnement Claude', planWhy: "Son prix mensuel, en dollars, pour le comparer à la valeur API de tes sessions.", planPlaceholder: 'ex. 100', save: 'Enregistrer',
  open3d: '3D', open3dFailed: 'La vue 3D n\'a pas pu s\'ouvrir dans le navigateur.', open3dBig: '⤢ Plein écran',
  follow: 'Suivre Claude', openLine: 'Ouvrir :', mapHelp: 'Clic gauche sur une note pour l\'ouvrir. Glisser avec le bouton gauche déplace en 2D ou fait pivoter en 3D ; avec le bouton droit, déplace. Glisser avec le bouton central zoome ; la molette aussi si l\'hôte la transmet.', subfolder: 'Sous-dossier…',
  settings: 'Réglages', openWith: 'Ouvrir les fichiers avec', openWithWhy: "L'app dans laquelle s'ouvre un fichier quand tu cliques sur son nom.",
  openMd: 'Notes Markdown (.md)', openOther: 'Autres fichiers', defaultApp: 'App par défaut du système',
  display: 'Affichage', language: 'Langue', hoverNames: 'Noms au survol', hoverWhy: 'Sur la carte, survoler un point affiche le nom de son fichier.',
  on: 'Activé', off: 'Désactivé',

  files: 'fichiers',
  whole: 'Tout voir', trail: 'Parcours',
  mapOnlyDesktop: "La carte s'affiche seulement dans l'app desktop.",
  packing: (s: number) => `Je range le dossier en un disque${s > 2 ? ` (${s} s)` : ''}…`,
  packFailed: "Impossible de lister le dossier :",
  retry: 'Réessayer',
  legend: 'Point plein : lu. Point cerclé : écrit. Point pâle : nom vu dans une recherche. Point bleu : le fichier en cours. Tirets : saut entre deux notes sans lien. Autour : les services appelés, avec leur nombre d\'appels.',
  figRead: 'fichiers lus', figWritten: 'écrits', figFound: 'vus en recherche', figGap: 'sauts sans lien', figCalls: 'appels MCP',
  lastSteps: 'Dernières étapes', noStep: 'Aucun fichier touché. Pose une question à Claude.',
  subAgent: 'sous-agent',
  filesIntro: 'Fichiers de la session, par dossier',
  gStart: 'Chargés avant ton premier message',
  gStartWhy: 'Fichiers d\'instructions et de mémoire (CLAUDE.md, AGENTS.md, leurs @imports, mémoire auto). Claude les relit à chaque requête.',
  gRead: 'Lus', gReadWhy: "Ouverts par Claude. Leur contenu reste dans le contexte jusqu'à la prochaine compaction.",
  gWritten: 'Écrits', gWrittenWhy: 'Créés ou modifiés par Claude. La modification est dans le contexte.',
  gFound: 'Vus dans un résultat', gFoundWhy: "Cités par une recherche, un listing, un connecteur ou le rapport d'un sous-agent. Seul leur nom (et la ligne trouvée) est entré dans le contexte, pas le fichier.",
  gLinked: 'Vus par un lien', gLinkedWhy: "Liés depuis une note que Claude a lue. Leur nom est entré avec cette note ; Claude peut suivre le lien.",
  lgRead: 'lus', lgWrite: 'écrits', lgFound: 'vus dans un résultat', lgLinked: 'vus par un lien', lgGap: 'sauts sans lien',
  wheelHint: 'Molette sur la carte : zoom.',
  homeRoot: "Cette session tourne dans ton dossier personnel. La carte n'en montre que les premiers niveaux : lance la session dans un dossier de projet ou un vault pour le voir en entier.",
  gAgent: 'Lus par un sous-agent', gAgentWhy: 'Un sous-agent les a lus dans son propre contexte. Seul son résumé est revenu ici.',
  outside: 'hors de ce dossier',
  times: (r: number, w: number) => [r > 0 ? `lu ×${r}` : '', w > 0 ? `écrit ×${w}` : ''].filter(Boolean).join(' · '),
  noFiles: 'Rien pour le moment.',
  kpiRead: (n: number) => `lu ${n}×`, kpiWrite: (n: number) => `écrit ${n}×`, kpiTokens: (t: string) => `≈${t} tokens`, kpiEmpty: 'Aucun fichier ici dans cette session.',
  missing: 'Liens manquants',
  missingWhy: 'Des notes que Claude a enchaînées sans lien entre elles. Ajouter le lien aide la prochaine session à s\'y retrouver.',
  then: 'puis',
  copy: 'Copier', copied: 'Copié', open: 'Ouvrir',
  window: 'Fenêtre de contexte',
  ofTokens: (t: string, w: string) => `${t} sur ${w} tokens`,
  noReading: 'Pas encore de mesure : la jauge se remplit après la première réponse.',
  compactAt: (p: number) => `Compaction auto à ${p} %`,
  compactOff: 'Compaction auto désactivée',
  zone: {
    ok: 'Il reste de la place. Continue.',
    warn: 'Au-delà de la moitié, les réponses perdent en précision. Termine la tâche en cours, puis compacte avec un focus.',
    bad: 'La fenêtre est presque pleine. Ouvre une nouvelle session avec une passation, ou compacte maintenant.',
  },
  compactNow: 'Compacter', toHandoff: 'Préparer la passation',
  compactBusy: 'Claude travaille. Compacte à la fin du tour.',
  compactDone: 'Compacté.',
  startTitle: 'Chargé avant ton premier message',
  startWhy: "Claude porte tout ça avant que tu tapes quoi que ce soit, et le paie à chaque requête.",
  memory: "Fichiers d'instructions et de mémoire", mcp: 'Outils MCP', skills: 'Skills', agents: 'Agents personnalisés',
  mcpLine: (s: number, t: number) => `${s} serveurs, ${t} outils`,
  skillsLine: (n: number, of: number) => `${n} listés sur ${of}`,
  deferred: 'chargés à la demande',
  eaters: 'Ce qui le remplit',
  eatersWhy: "Les résultats d'outils qui prennent le plus de place depuis la dernière compaction (estimation).",
  noEaters: "Pas encore de résultat d'outil.",
  tip: {
    Read: "Lire une plage (offset et limit) ou chercher dans le fichier d'abord.",
    Bash: 'Filtrer les longues sorties avec head, tail ou grep.',
    Grep: 'Resserrer la recherche avec un glob, ou ne lister que les noms.',
    Glob: 'Resserrer le motif.',
    WebFetch: 'Demander un résumé, ou confier la page à un sous-agent.',
    Agent: "C'est le résumé du sous-agent : ses lectures sont restées dehors.",
    mcp: 'Demander moins de champs ou une page plus petite au service.',
    other: 'Confier les grosses lectures à un sous-agent : seul son résumé revient.',
  },
  categories: 'Répartition',
  hoTitle: 'Changer de session sans perdre le fil',
  hoWhy: "Une nouvelle session part d'une fenêtre vide. Ce brief transmet l'essentiel : l'objectif, ce qui est fait, les décisions, les fichiers, la suite.",
  hoWhen: 'Compacte si tu restes sur la même tâche. Change de session quand la tâche change ou que la fenêtre dépasse 75 %.',
  hoWrite: 'Écrire la passation', hoBusy: 'Rédaction…', hoAgain: 'La réécrire',
  hoPaste: 'Copie-la, ouvre une nouvelle session, colle-la comme premier message.',
  hoFailed: "La passation n'a pas pu être écrite :",
  hoEmpty: "Rien à transmettre : la session n'a pas encore d'échange.",
  clear: 'Effacer le parcours', lang: 'English',
  opened: 'Brain Trail ouvert.', later: "Brain Trail s'ouvrira quand l'app sera attachée à la session.",
  toastWarn: 'Contexte au-delà de 50 %. Brain Trail : pense à compacter.',
  toastBad: 'Contexte au-delà de 75 %. Brain Trail : passe à une nouvelle session.',
}

const cache = new Map<string, Strings>()
export const strings = (lang: Lang, assistant = 'Claude', costInfoCommand = '/cost'): Strings => {
  const base = lang === 'fr' ? fr : en
  if (assistant === 'Claude' && costInfoCommand === '/cost') return base
  const key = JSON.stringify([lang, assistant, costInfoCommand])
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const rename = (text: string) => text.replaceAll('Claude', assistant)
  const tip = (value: { title: string; body: string }) => ({ title: rename(value.title), body: rename(value.body) })
  const result: Strings = {
    ...base,
    costHow: costInfoCommand === '/cost' ? base.costHow : lang === 'fr'
      ? `Le chiffre est celui de ${costInfoCommand} : les tokens comptés par le moteur, au prix de l'API. Ta session habituelle est la médiane des sessions passées vues par Brain Trail.`
      : `The figure is the one ${costInfoCommand} gives: tokens counted by the engine, at API prices. Your usual session is the median of the past sessions Brain Trail saw.`,
    planUse: assistant === 'Claude' ? base.planUse : lang === 'fr' ? 'Ton abonnement IA' : 'Your AI plan',
    planTitle: assistant === 'Claude' ? base.planTitle : lang === 'fr' ? 'Ton abonnement IA' : 'Your AI plan',
    noGoal: rename(base.noGoal), planOfClaude: rename(base.planOfClaude), whatClaudeDid: rename(base.whatClaudeDid),
    thinking: rename(base.thinking), noAction: rename(base.noAction), mapEmpty: rename(base.mapEmpty),
    tipBigRead: (f, t) => { const value = base.tipBigRead(f, t); return { ...value, body: rename(value.body) } },
    tipReread: (f, n) => { const value = base.tipReread(f, n); return { ...value, body: rename(value.body) } },
    tipSearch: n => tip(base.tipSearch(n)),
    tipShort: (p, n) => { const value = base.tipShort(p, n); return { ...value, title: lang === 'fr' ? `« ${p} » a laissé ${assistant} deviner` : `« ${p} » left ${assistant} guessing` } },
    tipLinks: n => tip(base.tipLinks(n)), tipMemory: t => tip(base.tipMemory(t)), tipWindow: p => tip(base.tipWindow(p)),
    coachWhy: rename(base.coachWhy), applyWith: f => rename(base.applyWith(f)), applyHow: rename(base.applyHow),
    academyWhy: rename(base.academyWhy), follow: rename(base.follow), legend: rename(base.legend),
    noStep: rename(base.noStep), gStartWhy: rename(base.gStartWhy), gReadWhy: rename(base.gReadWhy),
    gWrittenWhy: rename(base.gWrittenWhy), gLinkedWhy: rename(base.gLinkedWhy), missingWhy: rename(base.missingWhy),
    compactBusy: rename(base.compactBusy), startWhy: rename(base.startWhy),
  }
  cache.set(key, result)
  return result
}
export type { Strings }

export const handoffPrompt = (lang: Lang, files: string) => (lang === 'fr'
  ? `Écris une passation pour reprendre ce travail dans une nouvelle session Claude Code, qui ne verra rien de cette conversation.
Format Markdown, court, en français, sans tiret long :
## Objectif (1 à 2 phrases)
## Ce qui est fait (puces)
## Décisions prises (puces, avec la raison en quelques mots)
## Fichiers clés (chemin + une ligne sur son rôle)
## Prochaine étape (la première action concrète)
## Points ouverts (questions, risques, ce qui n'est pas vérifié)
N'invente rien : si une section est vide, écris "Rien".
Fichiers touchés pendant la session :
${files}`
  : `Write a hand-off brief to resume this work in a new Claude Code session that will see nothing of this conversation.
Markdown, short, in English:
## Goal (1 to 2 sentences)
## Done (bullets)
## Decisions (bullets, with the reason in a few words)
## Key files (path + one line on its role)
## Next step (the first concrete action)
## Open points (questions, risks, what is not verified)
Invent nothing: if a section is empty, write "None".
Files touched during the session:
${files}`)

export const coachPrompt = (lang: Lang, file: string, assistant = 'Claude') => (lang === 'fr'
  ? `Tu es un coach métier. Tu aides un dirigeant ou un collaborateur non technique à obtenir plus d'impact business de ${assistant}. Relis cette conversation et réponds en Markdown, court, concret, en tutoyant, sans tiret long.
Règle absolue : ne parle jamais de code, de commandes, de logiciels, de versions, de tokens, de fichiers techniques ni d'outils de développement. Si la conversation est technique, garde seulement ce qu'un dirigeant peut en retenir pour mieux travailler.
## Tes demandes
2 à 3 conseils sur la façon de formuler une demande : le résultat attendu, pour qui, à partir de quels documents, sous quelle forme. Termine par la réécriture d'une de tes demandes de cette conversation, telle qu'un dirigeant l'écrirait.
## Ce que ${assistant} devrait savoir de ton entreprise
2 à 3 conseils : les informations métier qui lui ont manqué (offres, clients, priorités, règles, vocabulaire) et qui l'ont obligé à chercher ou à deviner.
## À ajouter au contexte de ton entreprise
Une phrase, puis un bloc qui commence par \`\`\`context et contient uniquement les lignes à ajouter à ${file}, rédigées comme des connaissances sur l'entreprise, jamais techniques, prêtes à coller (5 lignes au plus).
N'invente rien qui ne vienne pas de la conversation.`
  : `You are a business coach. You help a business leader or a non-technical colleague get more business impact from ${assistant}. Read this conversation again and answer in Markdown, short and concrete.
Absolute rule: never talk about code, commands, software, versions, tokens, technical files or development tools. If the conversation is technical, keep only what a business leader can learn from it to work better.
## Your requests
2 to 3 tips on how to phrase a request: the expected result, for whom, from which documents, in what form. End with a rewrite of one of your requests from this conversation, as a business leader would write it.
## What ${assistant} should know about your company
2 to 3 tips: the business information it lacked (offers, clients, priorities, rules, vocabulary) and had to search for or guess.
## To add to your company context
One sentence, then a block that starts with \`\`\`context and holds only the lines to add to ${file}, written as knowledge about the company, never technical, ready to paste (5 lines at most).
Invent nothing that does not come from the conversation.`)
