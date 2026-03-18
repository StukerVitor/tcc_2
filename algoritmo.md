### Algoritmo em português

```text
Algoritmo: LASCAS — Simplificação sensível ao nível

Entrada:
  T = texto original
  nível ∈ {light, medium, strong}

Saída:
  S = texto simplificado

1. T0 ← normalizar artefatos jurídicos de T
2. T1 ← pré-estruturar o texto T0

3. Se nível = light então
4.     Proteger em T1 os elementos sensíveis
       (datas, valores, números, citações legais, negações etc.)
5.     Separar o texto em parágrafos
6.     Para cada parágrafo:
7.         Se o parágrafo parecer cabeçalho, manter como está
8.         Senão, separar o parágrafo em frases
9.         Para cada frase:
10.            Tentar reescrever a frase com o modelo local
11.            Se a reescrita for aceitável, usar a nova versão
12.            Senão, manter a frase original
13.        Juntar novamente as frases do parágrafo
14.    Restaurar os elementos protegidos
15.    Aplicar pós-estruturação e normalização final
16.    Inserir anotações de glossário na primeira ocorrência
17.    Se a integridade semântica falhar em modo estrito:
18.        usar fallback determinístico

19. Senão  // níveis medium ou strong
20.    Separar o texto em blocos de tamanho controlado
21.    Para cada bloco:
22.        Selecionar os elementos essenciais que devem ser preservados
23.        Tentar condensar o bloco com o modelo local
24.        Se a condensação for aceitável, usar a nova versão
25.        Senão, aplicar condensação heurística
26.    Juntar os blocos processados
27.    Aplicar pós-estruturação e normalização final
28.    Inserir anotações de glossário na primeira ocorrência
29.    Se a integridade semântica falhar em modo resumo:
30.        usar fallback determinístico

31. Retornar S