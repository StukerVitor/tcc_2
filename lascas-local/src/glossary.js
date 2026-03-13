function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const B = '[^\\p{L}\\p{N}]';

export const GLOSSARY = [
  { id: 'inventario', terms: ['inventário'], explanation: 'procedimento para levantar bens e dívidas do falecido' },
  { id: 'partilha', terms: ['partilha'], explanation: 'divisão dos bens entre os herdeiros' },
  { id: 'espolio', terms: ['espólio'], explanation: 'conjunto de bens e dívidas deixados pelo falecido' },
  { id: 'inventariante', terms: ['inventariante'], explanation: 'pessoa responsável por representar e administrar o espólio' },
  { id: 'sobrepartilha', terms: ['sobrepartilha'], explanation: 'partilha posterior de bens fora do inventário inicial' },
  { id: 'itcmd', terms: ['ITCMD', 'ITCDM'], explanation: 'imposto cobrado na transmissão de herança ou doação' },

  { id: 'outorgante', terms: ['outorgante', 'outorgantes'], explanation: 'quem assina o documento' },
  { id: 'outorgado', terms: ['outorgado', 'outorgados'], explanation: 'quem recebe o direito ou poder neste ato' },
  { id: 'interveniente', terms: ['interveniente', 'intervenientes'], explanation: 'quem participa para confirmar ou assistir o ato' },
  { id: 'assistente', terms: ['assistente', 'assistentes'], explanation: 'quem participa ou acompanha o ato; o sentido depende do documento' },
  { id: 'locador', terms: ['locador', 'locadora'], explanation: 'quem cede o imóvel para aluguel' },
  { id: 'locatario', terms: ['locatário', 'locatária'], explanation: 'quem aluga e usa o imóvel' },
  { id: 'fiador', terms: ['fiador', 'fiadora', 'fiadores'], explanation: 'quem garante o contrato se o locatário não pagar' },
  { id: 'contratante', terms: ['contratante'], explanation: 'parte que contrata e recebe o serviço ou fornecimento' },
  { id: 'contratada', terms: ['contratada'], explanation: 'parte que executa o serviço ou fornece o objeto contratado' },
  { id: 'doravante', terms: ['doravante'], explanation: 'daqui em diante, com esse nome usado no restante do documento' },
  { id: 'reclamante', terms: ['reclamante'], explanation: 'quem ajuizou a ação trabalhista' },
  { id: 'reclamada', terms: ['reclamada'], explanation: 'empresa ou pessoa que responde à ação trabalhista' },
  { id: 'litigantes', terms: ['litigantes'], explanation: 'as partes que estão em disputa no processo' },
  { id: 'parte_autora', terms: ['parte autora', 'autora', 'autor', 'requerente'], explanation: 'quem entrou com o processo e fez os pedidos' },
  { id: 'parte_re', terms: ['parte ré', 'ré', 'réu', 'requerido', 'requerida'], explanation: 'quem foi apontado no processo para responder aos pedidos' },
  { id: 'valor_causa', terms: ['valor da causa'], explanation: 'valor atribuído ao processo para fins processuais' },

  { id: 'de_cujus', terms: ['de cujus'], explanation: 'expressão para “pessoa falecida”' },
  { id: 'dou_fe', terms: ['dou fé'], explanation: 'o cartório confirma identidades e capacidade das partes' },
  { id: 'transitado', terms: ['transitado em julgado'], explanation: 'decisão definitiva, sem recurso' },
  { id: 'contestacao', terms: ['contestação'], explanation: 'resposta apresentada pela parte ré para se defender' },
  { id: 'fundamentacao', terms: ['fundamentação'], explanation: 'parte em que o juiz explica por que decidiu daquele modo' },
  { id: 'merito', terms: ['mérito'], explanation: 'ponto principal discutido e decidido no processo' },
  { id: 'dispositivo', terms: ['dispositivo'], explanation: 'parte final que diz exatamente o que foi decidido' },
  { id: 'fase_instrucao', terms: ['fase de instrução'], explanation: 'etapa em que o processo recebe provas e depoimentos' },
  { id: 'inexitosas', terms: ['inexitosas'], explanation: 'que não tiveram êxito, ou seja, não deram certo' },
  { id: 'jurisprudencia', terms: ['jurisprudência'], explanation: 'conjunto de decisões anteriores usadas como referência' },
  { id: 'lei_licitacoes', terms: ['Lei de Licitações'], explanation: 'lei que regula contratações feitas pela administração pública' },

  { id: 'ssp_rs', terms: ['SSP/RS'], explanation: 'Secretaria de Segurança Pública do RS' },
  { id: 'oab_rs', terms: ['OAB/RS'], explanation: 'Ordem dos Advogados do Brasil do RS' },
  { id: 'comunhao_parcial', terms: ['comunhão parcial de bens'], explanation: 'divide os bens adquiridos durante o casamento' },
  { id: 'comunhao_universal', terms: ['comunhão universal de bens'], explanation: 'inclui quase todos os bens do casal' },
  { id: 'litisconsorcio', terms: ['litisconsórcio'], explanation: 'várias partes no mesmo processo' },
  { id: 'tutela_antecipada', terms: ['tutela antecipada'], explanation: 'decisão provisória antes do final do processo' },
  { id: 'coisa_julgada', terms: ['coisa julgada'], explanation: 'decisão definitiva que não pode ser alterada' },
  { id: 'onus_prova', terms: ['ônus da prova'], explanation: 'responsabilidade de provar um fato' },
  { id: 'perempcao', terms: ['perempção'], explanation: 'perda do direito de propor novamente por inércia' },
  { id: 'preclusao', terms: ['preclusão'], explanation: 'perda de um direito processual por prazo' },
  { id: 'prescricao', terms: ['prescrição'], explanation: 'perda do direito de cobrar em juízo após certo tempo' },
  { id: 'decadencia', terms: ['decadência'], explanation: 'perda do próprio direito pelo tempo' },
  { id: 'hipossuficiente', terms: ['hipossuficiente'], explanation: 'pessoa em desvantagem econômica ou técnica' },
  { id: 'ato_continuo', terms: ['ato contínuo'], explanation: 'logo em seguida' },
  { id: 'ex_vi_legis', terms: ['ex vi legis'], explanation: 'por força de lei' },
  { id: 'ex_tunc', terms: ['ex tunc'], explanation: 'efeitos retroativos' },
  { id: 'ex_nunc', terms: ['ex nunc'], explanation: 'efeitos a partir de agora' },
  { id: 'foro_competente', terms: ['foro competente'], explanation: 'local correto para julgar o caso' },
  { id: 'legitimidade_ativa', terms: ['legitimidade ativa'], explanation: 'quem pode entrar com a ação' },
  { id: 'legitimidade_passiva', terms: ['legitimidade passiva'], explanation: 'quem deve responder à ação' },
  { id: 'agravo', terms: ['agravo'], explanation: 'recurso contra decisão durante o processo' },
  { id: 'embargos', terms: ['embargos'], explanation: 'meio de contestar ou ajustar decisão' },
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
