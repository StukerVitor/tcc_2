function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Unicode-safe boundary for letters/numbers
const B = '[^\\p{L}\\p{N}]';

// Grouped glossary so explanations appear only once per concept
export const GLOSSARY = [
  // Notarial / probate basics
  { id: 'inventario', terms: ['inventário'], explanation: 'procedimento para levantar bens e dívidas do falecido' },
  { id: 'partilha', terms: ['partilha'], explanation: 'divisão dos bens entre os herdeiros' },
  { id: 'espolio', terms: ['espólio'], explanation: 'conjunto de bens e dívidas deixados pelo falecido' },
  { id: 'inventariante', terms: ['inventariante'], explanation: 'pessoa responsável por representar e administrar o espólio' },
  { id: 'sobrepartilha', terms: ['sobrepartilha'], explanation: 'partilha posterior de bens fora do inventário inicial' },

  // Parties / roles (avoid “herança” confusion)
  { id: 'outorgante', terms: ['outorgante', 'outorgantes'], explanation: 'quem assina o documento' },
  { id: 'outorgado', terms: ['outorgado', 'outorgados'], explanation: 'quem recebe o direito/poder neste ato' },
  { id: 'interveniente', terms: ['interveniente', 'intervenientes'], explanation: 'quem participa para confirmar/assistir o ato' },
  { id: 'assistente', terms: ['assistente', 'assistentes'], explanation: 'quem acompanha o ato (ex.: advogado)' },

  // Common legal expressions
  { id: 'de_cujus', terms: ['de cujus'], explanation: 'expressão para “pessoa falecida”' },
  { id: 'dou_fe', terms: ['dou fé'], explanation: 'o cartório confirma identidades/capacidades' },
  { id: 'transitado', terms: ['transitado em julgado'], explanation: 'decisão definitiva, sem recurso' },

  // Acronyms often appearing in IDs
  { id: 'ssp_rs', terms: ['SSP/RS'], explanation: 'Secretaria de Segurança Pública do RS' },
  { id: 'oab_rs', terms: ['OAB/RS'], explanation: 'Ordem dos Advogados do Brasil do RS' },

  // Marital regimes
  { id: 'comunhao_parcial', terms: ['comunhão parcial de bens'], explanation: 'divide bens adquiridos durante o casamento' },
  { id: 'comunhao_universal', terms: ['comunhão universal de bens'], explanation: 'inclui quase todos os bens do casal' },

  // Existing legal glossary
  { id: 'litisconsorcio', terms: ['litisconsórcio'], explanation: 'várias partes no mesmo processo' },
  { id: 'tutela_antecipada', terms: ['tutela antecipada'], explanation: 'decisão provisória antes do final do processo' },
  { id: 'coisa_julgada', terms: ['coisa julgada'], explanation: 'decisão definitiva que não pode ser alterada' },
  { id: 'onus_prova', terms: ['ônus da prova'], explanation: 'responsabilidade de provar um fato' },
  { id: 'perempcao', terms: ['perempção'], explanation: 'perda do direito de propor novamente por inércia' },
  { id: 'preclusao', terms: ['preclusão'], explanation: 'perda de um direito processual por prazo' },
  { id: 'prescricao', terms: ['prescrição'], explanation: 'perda do direito de cobrar em juízo após certo tempo' },
  { id: 'decadencia', terms: ['decadência'], explanation: 'perda do próprio direito pelo tempo' },
  { id: 'hipossuficiente', terms: ['hipossuficiente'], explanation: 'pessoa em desvantagem econômica/técnica' },
  { id: 'ato_continuo', terms: ['ato contínuo'], explanation: 'logo em seguida' },
  { id: 'ex_vi_legis', terms: ['ex vi legis'], explanation: 'por força de lei' },
  { id: 'ex_tunc', terms: ['ex tunc'], explanation: 'efeitos retroativos' },
  { id: 'ex_nunc', terms: ['ex nunc'], explanation: 'efeitos a partir de agora' },
  { id: 'foro_competente', terms: ['foro competente'], explanation: 'local correto para julgar o caso' },
  { id: 'legitimidade_ativa', terms: ['legitimidade ativa'], explanation: 'quem pode entrar com a ação' },
  { id: 'legitimidade_passiva', terms: ['legitimidade passiva'], explanation: 'quem deve responder à ação' },
  { id: 'agravo', terms: ['agravo'], explanation: 'recurso contra decisão durante o processo' },
  { id: 'embargos', terms: ['embargos'], explanation: 'meio de contestar/ajustar decisão' },
  { id: 'intimacao', terms: ['intimação'], explanation: 'comunicação oficial de ato do processo' },
  { id: 'citacao', terms: ['citação'], explanation: 'chamamento do réu para se defender' },
];

export function annotateFirstOccurrences(text) {
  let out = String(text ?? '');
  const explained = new Set();

  for (const entry of GLOSSARY) {
    if (explained.has(entry.id)) continue;

    for (const term of entry.terms) {
      const pat = new RegExp(`(^|${B})(${escapeRe(term)})(${B}|$)`, 'iu');
      if (pat.test(out)) {
        out = out.replace(pat, (_m, p1, p2, p3) => `${p1}${p2} (${entry.explanation})${p3}`);
        explained.add(entry.id);
        break;
      }
    }
  }

  return out;
}
