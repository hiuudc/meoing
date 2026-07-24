import { getSupportedLanguage, type SupportedLanguage } from "./languages";
import { decorateLessonPresentation } from "./questionSettings";
import type {
  GlossaryEntry,
  LearningProfile,
  Lesson,
  LessonQuestion,
  QuestionFormat,
} from "./types";

interface DemoLanguageContent {
  nativeName: string;
  hello: string;
  morning: string;
  thanks: string;
  water: string;
  tea: string;
  student: string;
  teacher: string;
  drinkWater: string;
  drinkTea: string;
  askWater: string;
  tokens: [string, string, string];
  separator: "space" | "none";
  pronunciation?: Partial<Record<keyof DemoLanguageContent, { native?: string; romanized?: string }>>;
}

interface DemoSourceCopy {
  title: string;
  summary: string;
  objective: string;
  theoryTitle: string;
  theoryBody: string;
  explanation: string;
  hint: string;
  sourceTitle: string;
  drinkCategory: string;
  personCategory: string;
  prompts: Record<QuestionFormat, string>;
}

const TARGET_CONTENT: Record<SupportedLanguage, DemoLanguageContent> = {
  English: {
    nativeName: "English",
    hello: "Hello",
    morning: "Good morning",
    thanks: "Thank you",
    water: "water",
    tea: "tea",
    student: "student",
    teacher: "teacher",
    drinkWater: "I drink water.",
    drinkTea: "I drink tea.",
    askWater: "Do you drink water?",
    tokens: ["I", "drink", "water"],
    separator: "space",
  },
  Vietnamese: {
    nativeName: "Tiếng Việt",
    hello: "Xin chào",
    morning: "Chào buổi sáng",
    thanks: "Cảm ơn",
    water: "nước",
    tea: "trà",
    student: "học sinh",
    teacher: "giáo viên",
    drinkWater: "Tôi uống nước.",
    drinkTea: "Tôi uống trà.",
    askWater: "Bạn có uống nước không?",
    tokens: ["Tôi", "uống", "nước"],
    separator: "space",
  },
  Japanese: {
    nativeName: "日本語",
    hello: "こんにちは",
    morning: "おはようございます",
    thanks: "ありがとうございます",
    water: "水",
    tea: "お茶",
    student: "学生",
    teacher: "先生",
    drinkWater: "私は水を飲みます。",
    drinkTea: "私はお茶を飲みます。",
    askWater: "水を飲みますか。",
    tokens: ["私は", "水を", "飲みます"],
    separator: "none",
    pronunciation: {
      nativeName: { native: "にほんご", romanized: "nihongo" },
      hello: { native: "こんにちは", romanized: "konnichiwa" },
      morning: { native: "おはようございます", romanized: "ohayou gozaimasu" },
      thanks: { native: "ありがとうございます", romanized: "arigatou gozaimasu" },
      water: { native: "みず", romanized: "mizu" },
      tea: { native: "おちゃ", romanized: "ocha" },
      student: { native: "がくせい", romanized: "gakusei" },
      teacher: { native: "せんせい", romanized: "sensei" },
      drinkWater: { native: "わたしはみずをのみます", romanized: "watashi wa mizu o nomimasu" },
      drinkTea: { native: "わたしはおちゃをのみます", romanized: "watashi wa ocha o nomimasu" },
      askWater: { native: "みずをのみますか", romanized: "mizu o nomimasu ka" },
    },
  },
  Spanish: {
    nativeName: "Español",
    hello: "Hola",
    morning: "Buenos días",
    thanks: "Gracias",
    water: "agua",
    tea: "té",
    student: "estudiante",
    teacher: "profesor",
    drinkWater: "Yo bebo agua.",
    drinkTea: "Yo bebo té.",
    askWater: "¿Bebes agua?",
    tokens: ["Yo", "bebo", "agua"],
    separator: "space",
  },
  Chinese: {
    nativeName: "中文",
    hello: "你好",
    morning: "早上好",
    thanks: "谢谢",
    water: "水",
    tea: "茶",
    student: "学生",
    teacher: "老师",
    drinkWater: "我喝水。",
    drinkTea: "我喝茶。",
    askWater: "你喝水吗？",
    tokens: ["我", "喝", "水"],
    separator: "none",
    pronunciation: {
      nativeName: { native: "zhōng wén", romanized: "zhong wen" },
      hello: { native: "nǐ hǎo", romanized: "ni hao" },
      morning: { native: "zǎo shang hǎo", romanized: "zao shang hao" },
      thanks: { native: "xiè xie", romanized: "xie xie" },
      water: { native: "shuǐ", romanized: "shui" },
      tea: { native: "chá", romanized: "cha" },
      student: { native: "xué sheng", romanized: "xue sheng" },
      teacher: { native: "lǎo shī", romanized: "lao shi" },
      drinkWater: { native: "wǒ hē shuǐ", romanized: "wo he shui" },
      drinkTea: { native: "wǒ hē chá", romanized: "wo he cha" },
      askWater: { native: "nǐ hē shuǐ ma", romanized: "ni he shui ma" },
    },
  },
  Korean: {
    nativeName: "한국어",
    hello: "안녕하세요",
    morning: "좋은 아침이에요",
    thanks: "감사합니다",
    water: "물",
    tea: "차",
    student: "학생",
    teacher: "선생님",
    drinkWater: "저는 물을 마셔요.",
    drinkTea: "저는 차를 마셔요.",
    askWater: "물을 마셔요?",
    tokens: ["저는", "물을", "마셔요"],
    separator: "space",
    pronunciation: {
      nativeName: { native: "한국어", romanized: "hangugeo" },
      hello: { native: "안녕하세요", romanized: "annyeonghaseyo" },
      morning: { native: "좋은 아침이에요", romanized: "joeun achimieyo" },
      thanks: { native: "감사합니다", romanized: "gamsahamnida" },
      water: { native: "물", romanized: "mul" },
      tea: { native: "차", romanized: "cha" },
      student: { native: "학생", romanized: "haksaeng" },
      teacher: { native: "선생님", romanized: "seonsaengnim" },
      drinkWater: { native: "저는 물을 마셔요", romanized: "jeoneun mureul masyeoyo" },
      drinkTea: { native: "저는 차를 마셔요", romanized: "jeoneun chareul masyeoyo" },
      askWater: { native: "물을 마셔요", romanized: "mureul masyeoyo" },
    },
  },
  French: {
    nativeName: "Français",
    hello: "Bonjour",
    morning: "Bonjour",
    thanks: "Merci",
    water: "eau",
    tea: "thé",
    student: "élève",
    teacher: "professeur",
    drinkWater: "Je bois de l'eau.",
    drinkTea: "Je bois du thé.",
    askWater: "Tu bois de l'eau ?",
    tokens: ["Je", "bois", "de l'eau"],
    separator: "space",
  },
  German: {
    nativeName: "Deutsch",
    hello: "Hallo",
    morning: "Guten Morgen",
    thanks: "Danke",
    water: "Wasser",
    tea: "Tee",
    student: "Schüler",
    teacher: "Lehrer",
    drinkWater: "Ich trinke Wasser.",
    drinkTea: "Ich trinke Tee.",
    askWater: "Trinkst du Wasser?",
    tokens: ["Ich", "trinke", "Wasser"],
    separator: "space",
  },
};

function prompts(values: string[]): Record<QuestionFormat, string> {
  const formats: QuestionFormat[] = [
    "singleChoice", "multipleChoice", "trueFalse", "fillBlank", "selectBlank",
    "multiCloze", "wordBank", "matching", "reorderTokens", "reorderDialogue",
    "categorize", "translation", "shortAnswer", "errorCorrection",
    "sentenceTransformation", "dictation", "freeWriting", "speakingRepeat",
    "speakingRoleplay", "listenSelect", "audioMatching", "soundDiscrimination",
    "flashcardRecall", "characterTracing",
  ];
  const expanded = [
    ...values,
    values[15],
    values[7],
    values[15],
    values[18],
    values[3],
  ];
  return Object.fromEntries(formats.map((format, index) => [format, expanded[index]])) as Record<QuestionFormat, string>;
}

const SOURCE_COPY: Record<SupportedLanguage, DemoSourceCopy> = {
  English: {
    title: "Language-pair player demo",
    summary: "A complete 24-format lesson preview using the selected spoken and learning languages.",
    objective: "Recognize and produce a short everyday exchange.",
    theoryTitle: "Everyday communication",
    theoryBody: "Notice the target-language phrase, its meaning, and its natural word order.",
    explanation: "The model answer uses the target-language form shown in this lesson.",
    hint: "Use the glossary and the visible example.",
    sourceTitle: "Built-in language-pair demo",
    drinkCategory: "Drink",
    personCategory: "Person",
    prompts: prompts([
      "Choose the sentence about water.", "Choose both drinks.", "Is this a natural model sentence?",
      "Complete the missing word.", "Choose the missing word.", "Complete both missing parts.",
      "Build the model sentence.", "Match each meaning with its target-language word.",
      "Put the target-language words in order.", "Put the short dialogue in order.",
      "Sort each word by meaning.", "Translate into the learning language.",
      "Explain the meaning of the model sentence.", "Correct the target-language sentence.",
      "Rewrite the sentence as a question.", "Type the sentence you hear.",
      "Write a short everyday message.", "Repeat the target-language sentence.",
      "Respond in the learning language.",
    ]),
  },
  Vietnamese: {
    title: "Bài học mẫu theo cặp ngôn ngữ",
    summary: "Bài học xem trước đủ 24 dạng câu hỏi bằng ngôn ngữ bạn nói và ngôn ngữ đang học.",
    objective: "Nhận biết và sử dụng một đoạn giao tiếp ngắn hằng ngày.",
    theoryTitle: "Giao tiếp hằng ngày",
    theoryBody: "Quan sát câu ở ngôn ngữ đích, ý nghĩa và trật tự từ tự nhiên của câu.",
    explanation: "Đáp án mẫu dùng đúng dạng ngôn ngữ đích đã giới thiệu trong bài.",
    hint: "Hãy dùng bảng từ và ví dụ đang hiển thị.",
    sourceTitle: "Bài học mẫu theo cặp ngôn ngữ",
    drinkCategory: "Đồ uống",
    personCategory: "Con người",
    prompts: prompts([
      "Chọn câu nói về nước.", "Chọn cả hai đồ uống.", "Đây có phải câu mẫu tự nhiên không?",
      "Điền từ còn thiếu.", "Chọn từ còn thiếu.", "Hoàn thành cả hai phần còn thiếu.",
      "Ghép thành câu mẫu.", "Ghép mỗi nghĩa với từ trong ngôn ngữ đích.",
      "Sắp xếp các từ theo đúng thứ tự.", "Sắp xếp đoạn hội thoại ngắn.",
      "Phân loại từng từ theo nghĩa.", "Dịch sang ngôn ngữ đang học.",
      "Giải thích ý nghĩa của câu mẫu.", "Sửa câu trong ngôn ngữ đích.",
      "Viết lại câu thành câu hỏi.", "Nhập câu bạn nghe được.",
      "Viết một tin nhắn ngắn hằng ngày.", "Lặp lại câu trong ngôn ngữ đích.",
      "Trả lời bằng ngôn ngữ đang học.",
    ]),
  },
  Japanese: {
    title: "言語ペアのレッスンデモ",
    summary: "話す言語と学習言語を使った24形式のプレビューレッスンです。",
    objective: "短い日常会話を理解して使います。",
    theoryTitle: "日常会話",
    theoryBody: "学習言語の表現、意味、自然な語順を確認しましょう。",
    explanation: "模範解答はこのレッスンで示した学習言語の形を使います。",
    hint: "用語集と表示されている例を使ってください。",
    sourceTitle: "言語ペアの内蔵デモ",
    drinkCategory: "飲み物",
    personCategory: "人",
    prompts: prompts([
      "水についての文を選んでください。", "飲み物を二つ選んでください。", "これは自然な例文ですか。",
      "足りない語を入力してください。", "足りない語を選んでください。", "二つの空欄を完成させてください。",
      "例文を組み立ててください。", "意味と学習言語の語を組み合わせてください。",
      "語を正しい順番に並べてください。", "短い会話を順番に並べてください。",
      "意味ごとに分類してください。", "学習言語に訳してください。",
      "例文の意味を説明してください。", "学習言語の文を直してください。",
      "疑問文に書き換えてください。", "聞こえた文を入力してください。",
      "短い日常メッセージを書いてください。", "学習言語の文を繰り返してください。",
      "学習言語で答えてください。",
    ]),
  },
  Spanish: {
    title: "Demostración de la pareja de idiomas",
    summary: "Una lección de prueba con los 24 formatos y los idiomas seleccionados.",
    objective: "Reconocer y producir un intercambio cotidiano breve.",
    theoryTitle: "Comunicación cotidiana",
    theoryBody: "Observa la frase del idioma meta, su significado y su orden natural.",
    explanation: "La respuesta modelo usa la forma presentada en el idioma meta.",
    hint: "Usa el glosario y el ejemplo visible.",
    sourceTitle: "Demostración integrada de idiomas",
    drinkCategory: "Bebida",
    personCategory: "Persona",
    prompts: prompts([
      "Elige la frase sobre el agua.", "Elige las dos bebidas.", "¿Es una frase modelo natural?",
      "Completa la palabra que falta.", "Elige la palabra que falta.", "Completa las dos partes.",
      "Construye la frase modelo.", "Relaciona cada significado con la palabra meta.",
      "Ordena las palabras.", "Ordena el diálogo breve.", "Clasifica cada palabra.",
      "Traduce al idioma que aprendes.", "Explica el significado de la frase.",
      "Corrige la frase meta.", "Convierte la frase en una pregunta.",
      "Escribe la frase que escuchas.", "Escribe un mensaje cotidiano breve.",
      "Repite la frase meta.", "Responde en el idioma que aprendes.",
    ]),
  },
  Chinese: {
    title: "语言组合课程预览",
    summary: "使用所选母语和学习语言的二十四种题型预览。",
    objective: "理解并使用简短的日常交流。",
    theoryTitle: "日常交流",
    theoryBody: "观察目标语言句子的含义和自然语序。",
    explanation: "示范答案使用本课展示的目标语言形式。",
    hint: "请使用词汇表和屏幕上的例子。",
    sourceTitle: "内置语言组合预览",
    drinkCategory: "饮料",
    personCategory: "人物",
    prompts: prompts([
      "选择关于水的句子。", "选择两种饮料。", "这是自然的示范句吗？",
      "填写缺少的词。", "选择缺少的词。", "完成两个空格。",
      "组成示范句。", "把含义和目标语言词语配对。",
      "按正确顺序排列词语。", "排列简短对话。", "按含义分类。",
      "翻译成学习语言。", "解释示范句的含义。", "改正目标语言句子。",
      "把句子改成问句。", "输入你听到的句子。", "写一条简短的日常消息。",
      "重复目标语言句子。", "用学习语言回答。",
    ]),
  },
  Korean: {
    title: "언어 쌍 수업 미리보기",
    summary: "선택한 모국어와 학습 언어를 사용하는 24개 문제 형식의 수업입니다.",
    objective: "짧은 일상 대화를 이해하고 사용합니다.",
    theoryTitle: "일상 의사소통",
    theoryBody: "학습 언어 문장의 뜻과 자연스러운 어순을 확인하세요.",
    explanation: "모범 답안은 이 수업에서 제시한 학습 언어 형식을 사용합니다.",
    hint: "용어집과 화면의 예문을 사용하세요.",
    sourceTitle: "내장 언어 쌍 미리보기",
    drinkCategory: "음료",
    personCategory: "사람",
    prompts: prompts([
      "물에 관한 문장을 고르세요.", "두 음료를 모두 고르세요.", "자연스러운 예문인가요?",
      "빠진 단어를 입력하세요.", "빠진 단어를 고르세요.", "두 빈칸을 완성하세요.",
      "예문을 만드세요.", "뜻과 학습 언어 단어를 연결하세요.",
      "단어를 올바른 순서로 배열하세요.", "짧은 대화를 순서대로 배열하세요.",
      "뜻에 따라 분류하세요.", "학습 언어로 번역하세요.", "예문의 뜻을 설명하세요.",
      "학습 언어 문장을 고치세요.", "문장을 질문으로 바꾸세요.",
      "들은 문장을 입력하세요.", "짧은 일상 메시지를 쓰세요.",
      "학습 언어 문장을 따라 말하세요.", "학습 언어로 대답하세요.",
    ]),
  },
  French: {
    title: "Démo de la paire de langues",
    summary: "Une leçon complète de 24 formats avec les langues sélectionnées.",
    objective: "Reconnaître et produire un bref échange quotidien.",
    theoryTitle: "Communication quotidienne",
    theoryBody: "Observez la phrase cible, son sens et l'ordre naturel des mots.",
    explanation: "La réponse modèle utilise la forme cible présentée dans la leçon.",
    hint: "Utilisez le glossaire et l'exemple affiché.",
    sourceTitle: "Démo intégrée de la paire de langues",
    drinkCategory: "Boisson",
    personCategory: "Personne",
    prompts: prompts([
      "Choisissez la phrase sur l'eau.", "Choisissez les deux boissons.", "Cette phrase est-elle naturelle ?",
      "Complétez le mot manquant.", "Choisissez le mot manquant.", "Complétez les deux parties.",
      "Construisez la phrase modèle.", "Associez chaque sens au mot cible.",
      "Mettez les mots dans l'ordre.", "Mettez le dialogue dans l'ordre.",
      "Classez chaque mot.", "Traduisez dans la langue apprise.",
      "Expliquez le sens de la phrase.", "Corrigez la phrase cible.",
      "Transformez la phrase en question.", "Saisissez la phrase entendue.",
      "Écrivez un court message quotidien.", "Répétez la phrase cible.",
      "Répondez dans la langue apprise.",
    ]),
  },
  German: {
    title: "Vorschau für das Sprachenpaar",
    summary: "Eine vollständige Vorschau mit 24 Aufgabenformaten und den gewählten Sprachen.",
    objective: "Einen kurzen Alltagsdialog verstehen und verwenden.",
    theoryTitle: "Alltagskommunikation",
    theoryBody: "Beachte den Zielsatz, seine Bedeutung und die natürliche Wortstellung.",
    explanation: "Die Musterantwort verwendet die in der Lektion gezeigte Zielform.",
    hint: "Nutze das Glossar und das sichtbare Beispiel.",
    sourceTitle: "Integrierte Sprachenpaar-Vorschau",
    drinkCategory: "Getränk",
    personCategory: "Person",
    prompts: prompts([
      "Wähle den Satz über Wasser.", "Wähle beide Getränke.", "Ist dies ein natürlicher Beispielsatz?",
      "Ergänze das fehlende Wort.", "Wähle das fehlende Wort.", "Ergänze beide Lücken.",
      "Baue den Beispielsatz.", "Ordne jeder Bedeutung das Zielwort zu.",
      "Bringe die Wörter in Reihenfolge.", "Ordne den kurzen Dialog.",
      "Sortiere jedes Wort.", "Übersetze in die Lernsprache.",
      "Erkläre die Bedeutung des Satzes.", "Korrigiere den Zielsatz.",
      "Forme den Satz in eine Frage um.", "Tippe den gehörten Satz.",
      "Schreibe eine kurze Alltagsnachricht.", "Wiederhole den Zielsatz.",
      "Antworte in der Lernsprache.",
    ]),
  },
};

function contentFor(language: string): DemoLanguageContent {
  const supported = getSupportedLanguage(language)?.name ?? "English";
  return TARGET_CONTENT[supported];
}

function sourceCopyFor(language: string): DemoSourceCopy {
  const supported = getSupportedLanguage(language)?.name ?? "English";
  return SOURCE_COPY[supported];
}

function uniqueGlossary(target: DemoLanguageContent, source: DemoLanguageContent): GlossaryEntry[] {
  const keys: Array<keyof DemoLanguageContent> = [
    "nativeName", "hello", "morning", "thanks", "water", "tea", "student",
    "teacher", "drinkWater", "drinkTea", "askWater",
  ];
  const seen = new Set<string>();
  const entries = keys.flatMap((key): GlossaryEntry[] => {
    const term = target[key];
    if (typeof term !== "string" || seen.has(term)) return [];
    seen.add(term);
    const sourceMeaning = source[key];
    return [{
      term,
      meaning: typeof sourceMeaning === "string" ? sourceMeaning : term,
      pronunciation: target.pronunciation?.[key],
      example: key === "water" ? target.drinkWater : undefined,
    }];
  });
  target.tokens.forEach((term, index) => {
    if (seen.has(term)) return;
    seen.add(term);
    entries.push({ term, meaning: source.tokens[index] ?? term });
  });
  return entries;
}

function replaceFirst(text: string, value: string, replacement: string): string {
  const index = text.indexOf(value);
  return index < 0 ? text : `${text.slice(0, index)}${replacement}${text.slice(index + value.length)}`;
}

export function createLocalPreviewLesson(unitId: string, unitName: string, profile: LearningProfile): Lesson {
  const prefix = `${unitId}-preview`;
  const target = contentFor(profile.targetLanguage);
  const source = contentFor(profile.sourceLanguage);
  const copy = sourceCopyFor(profile.sourceLanguage);
  const explanation = copy.explanation;
  const hint = copy.hint;
  const blankWater = replaceFirst(target.drinkWater, target.water, "___");
  const selectWater = replaceFirst(target.drinkWater, target.water, "{{blank}}");
  const clozeSentence = target.tokens.map((token, index) => index === 0 ? token : "___").join(target.separator === "none" ? "" : " ");
  const glossary = uniqueGlossary(target, source);
  const answerBank = (
    values: string[],
    idPrefix: string,
    defaultMode: "keyboard" | "bank" = "bank",
  ) => ({
    tokens: [...new Set(values)].map((label, index) => ({ id: `${idPrefix}-${index}`, label })),
    separator: target.separator,
    defaultMode,
  } as const);
  const question = <Type extends LessonQuestion["type"]>(
    value: Omit<Extract<LessonQuestion, { type: Type }>, "id" | "explanation" | "hint"> & { type: Type },
    index: number,
  ): Extract<LessonQuestion, { type: Type }> => ({
    ...value,
    id: `${prefix}-q${index}`,
    explanation,
    hint,
  } as Extract<LessonQuestion, { type: Type }>);

  const questions: LessonQuestion[] = [
    question({
      type: "singleChoice",
      evaluationMode: "local",
      prompt: copy.prompts.singleChoice,
      options: [
        { id: "water", label: target.drinkWater },
        { id: "tea", label: target.drinkTea },
        { id: "hello", label: target.hello },
      ],
      correctOptionId: "water",
      glossaryTargets: [target.drinkWater, target.drinkTea, target.hello],
    }, 1),
    question({
      type: "multipleChoice",
      evaluationMode: "local",
      prompt: copy.prompts.multipleChoice,
      options: [
        { id: "water", label: target.water },
        { id: "tea", label: target.tea },
        { id: "student", label: target.student },
      ],
      correctOptionIds: ["water", "tea"],
      glossaryTargets: [target.water, target.tea, target.student],
    }, 2),
    question({
      type: "trueFalse",
      evaluationMode: "local",
      prompt: copy.prompts.trueFalse,
      statement: target.drinkWater,
      correct: true,
      glossaryTargets: [target.drinkWater],
    }, 3),
    question({
      type: "fillBlank",
      evaluationMode: "local",
      prompt: copy.prompts.fillBlank,
      template: blankWater,
      acceptedAnswers: [target.water],
      match: { ignorePunctuation: true },
      answerBank: answerBank([target.water, target.tea, target.student, target.teacher], "fill"),
      glossaryTargets: [target.tokens[0], target.water, target.tea, target.student, target.teacher],
    }, 4),
    question({
      type: "selectBlank",
      evaluationMode: "local",
      prompt: copy.prompts.selectBlank,
      template: selectWater,
      options: [
        { id: "water", label: target.water },
        { id: "tea", label: target.tea },
        { id: "teacher", label: target.teacher },
      ],
      correctOptionId: "water",
      glossaryTargets: [target.water, target.tea, target.teacher],
    }, 5),
    question({
      type: "multiCloze",
      evaluationMode: "local",
      prompt: copy.prompts.multiCloze,
      template: clozeSentence,
      blanks: [
        { id: "verb", acceptedAnswers: [target.tokens[1]] },
        { id: "object", acceptedAnswers: [target.tokens[2]] },
      ],
      match: { ignorePunctuation: true },
      answerBank: answerBank([...target.tokens, target.tea, target.teacher], "cloze"),
      glossaryTargets: [...target.tokens, target.tea, target.teacher],
    }, 6),
    question({
      type: "wordBank",
      evaluationMode: "local",
      prompt: copy.prompts.wordBank,
      tokens: target.tokens.map((label, index) => ({ id: `token-${index}`, label })),
      correctOrderIds: ["token-0", "token-1", "token-2"],
      glossaryTargets: [...target.tokens],
    }, 7),
    question({
      type: "matching",
      evaluationMode: "local",
      prompt: copy.prompts.matching,
      pairs: [
        { leftId: "water-source", left: source.water, rightId: "water-target", right: target.water },
        { leftId: "tea-source", left: source.tea, rightId: "tea-target", right: target.tea },
        { leftId: "student-source", left: source.student, rightId: "student-target", right: target.student },
      ],
      glossaryTargets: [target.water, target.tea, target.student],
    }, 8),
    question({
      type: "reorderTokens",
      evaluationMode: "local",
      prompt: copy.prompts.reorderTokens,
      tokens: target.tokens.map((label, index) => ({ id: `order-${index}`, label })),
      correctOrderIds: ["order-0", "order-1", "order-2"],
      glossaryTargets: [...target.tokens],
    }, 9),
    question({
      type: "reorderDialogue",
      evaluationMode: "local",
      prompt: copy.prompts.reorderDialogue,
      turns: [
        { id: "hello", speaker: "A", label: target.hello },
        { id: "morning", speaker: "B", label: target.morning },
        { id: "thanks", speaker: "A", label: target.thanks },
      ],
      correctOrderIds: ["hello", "morning", "thanks"],
      glossaryTargets: [target.hello, target.morning, target.thanks],
    }, 10),
    question({
      type: "categorize",
      evaluationMode: "local",
      prompt: copy.prompts.categorize,
      categories: [
        { id: "drink", label: copy.drinkCategory },
        { id: "person", label: copy.personCategory },
      ],
      items: [
        { id: "water", label: target.water, categoryId: "drink" },
        { id: "tea", label: target.tea, categoryId: "drink" },
        { id: "student", label: target.student, categoryId: "person" },
        { id: "teacher", label: target.teacher, categoryId: "person" },
      ],
      glossaryTargets: [target.water, target.tea, target.student, target.teacher],
    }, 11),
    question({
      type: "translation",
      evaluationMode: "ai",
      prompt: copy.prompts.translation,
      sourceText: source.drinkWater,
      targetLanguage: profile.targetLanguage,
      referenceAnswer: target.drinkWater,
      rubric: [copy.objective],
      answerBank: answerBank([target.drinkWater, ...target.tokens, target.drinkTea], "translation"),
      glossaryTargets: [target.drinkWater, ...target.tokens, target.drinkTea],
    }, 12),
    question({
      type: "shortAnswer",
      evaluationMode: "ai",
      prompt: `${copy.prompts.shortAnswer} ${target.drinkWater}`,
      referenceAnswer: source.drinkWater,
      requiredIdeas: [source.water],
      rubric: [copy.objective],
      answerBank: {
        tokens: [source.drinkWater, source.water, source.tea, source.student]
          .map((label, index) => ({ id: `short-${index}`, label })),
        separator: source.separator,
        defaultMode: "keyboard",
      },
      glossaryTargets: [target.drinkWater],
    }, 13),
    question({
      type: "errorCorrection",
      evaluationMode: "local",
      prompt: copy.prompts.errorCorrection,
      incorrectText: target.drinkTea,
      acceptedAnswers: [target.drinkTea],
      match: { ignorePunctuation: true },
      answerBank: answerBank([target.drinkTea, ...target.tokens, target.water, target.tea], "correction"),
      glossaryTargets: [target.drinkTea, ...target.tokens, target.water, target.tea],
    }, 14),
    question({
      type: "sentenceTransformation",
      evaluationMode: "local",
      prompt: copy.prompts.sentenceTransformation,
      sourceText: target.drinkWater,
      constraint: copy.prompts.sentenceTransformation,
      acceptedAnswers: [target.askWater],
      match: { ignorePunctuation: true },
      answerBank: answerBank([target.askWater, target.drinkWater, target.water, target.tea], "transform"),
      glossaryTargets: [target.drinkWater, target.askWater, target.water, target.tea],
    }, 15),
    question({
      type: "dictation",
      evaluationMode: "local",
      prompt: copy.prompts.dictation,
      transcript: target.morning,
      acceptedAnswers: [target.morning],
      match: { ignorePunctuation: true },
      answerBank: answerBank([target.morning, target.hello, target.thanks, target.water], "dictation"),
      glossaryTargets: [target.morning, target.hello, target.thanks, target.water],
    }, 16),
    question({
      type: "freeWriting",
      evaluationMode: "ai",
      prompt: copy.prompts.freeWriting,
      minWords: 2,
      maxWords: 30,
      rubric: [copy.objective],
      supportBank: [
        target.hello, target.morning, target.thanks, target.water,
        target.tea, target.student, target.teacher, target.drinkWater,
      ].map((label, index) => ({ id: `support-${index}`, label })),
      supportBankSeparator: target.separator,
      answerBank: answerBank([
        target.hello, target.morning, target.thanks, target.water,
        target.tea, target.student, target.teacher, target.drinkWater,
      ], "writing", "keyboard"),
      glossaryTargets: [
        target.hello, target.morning, target.thanks, target.water,
        target.tea, target.student, target.teacher, target.drinkWater,
      ],
    }, 17),
    question({
      type: "speakingRepeat",
      evaluationMode: "ai",
      prompt: copy.prompts.speakingRepeat,
      modelText: target.drinkWater,
      rubric: [copy.objective],
      glossaryTargets: [target.drinkWater],
    }, 18),
    question({
      type: "speakingRoleplay",
      evaluationMode: "ai",
      prompt: copy.prompts.speakingRoleplay,
      role: source.student,
      scenario: copy.objective,
      goal: target.askWater,
      rubric: [copy.objective],
      glossaryTargets: [target.askWater],
    }, 19),
    question({
      type: "listenSelect",
      evaluationMode: "local",
      prompt: copy.prompts.listenSelect,
      audioText: target.morning,
      options: [
        { id: "listen-morning", label: target.morning },
        { id: "listen-hello", label: target.hello },
        { id: "listen-thanks", label: target.thanks },
      ],
      correctOptionId: "listen-morning",
      glossaryTargets: [target.morning, target.hello, target.thanks],
    }, 20),
    question({
      type: "audioMatching",
      evaluationMode: "local",
      prompt: copy.prompts.audioMatching,
      pairs: [
        { audioId: "audio-water", audioText: target.water, matchId: "meaning-water", label: source.water },
        { audioId: "audio-tea", audioText: target.tea, matchId: "meaning-tea", label: source.tea },
        { audioId: "audio-student", audioText: target.student, matchId: "meaning-student", label: source.student },
      ],
      glossaryTargets: [target.water, target.tea, target.student],
    }, 21),
    question({
      type: "soundDiscrimination",
      evaluationMode: "local",
      prompt: copy.prompts.soundDiscrimination,
      audioText: target.water,
      options: [
        { id: "sound-water", label: target.water },
        { id: "sound-tea", label: target.tea },
        { id: "sound-teacher", label: target.teacher },
      ],
      correctOptionId: "sound-water",
      glossaryTargets: [target.water, target.tea, target.teacher],
    }, 22),
    question({
      type: "flashcardRecall",
      evaluationMode: "local",
      prompt: copy.prompts.flashcardRecall,
      cue: source.water,
      acceptedAnswers: [target.water],
      match: { ignorePunctuation: true },
      glossaryTargets: [],
    }, 23),
    question({
      type: "characterTracing",
      evaluationMode: "local",
      prompt: copy.prompts.characterTracing,
      character: target.water,
      meaning: source.water,
      reading: target.pronunciation?.water?.romanized ?? target.pronunciation?.water?.native,
      requireStrokeOrder: true,
      unavailableReason: ["Chinese", "Japanese", "Korean"].includes(profile.targetLanguage)
        ? undefined
        : `Character tracing is not available for ${profile.targetLanguage}.`,
      glossaryTargets: [target.water],
    }, 24),
  ];

  const questionAlternates = questions.map((primary, index) => {
    const listeningFormats = new Set(["dictation", "listenSelect", "audioMatching", "soundDiscrimination"]);
    const sourceQuestion = Array.from({ length: questions.length - 1 }, (_, offset) => (
      questions[(index + offset + 1) % questions.length]
    )).find((candidate) => (
      candidate.type !== primary.type
      && (!listeningFormats.has(primary.type) || !listeningFormats.has(candidate.type))
    )) ?? questions[(index + 1) % questions.length];
    const { templateId: _templateId, presentation: _presentation, ...alternate } = sourceQuestion;
    return {
      questionId: primary.id,
      question: { ...alternate, id: `${primary.id}-alternate` } as LessonQuestion,
    };
  });

  return decorateLessonPresentation({
    schemaVersion: 5,
    id: `${prefix}-lesson`,
    unitId,
    title: `${copy.title}: ${profile.sourceLanguage} → ${profile.targetLanguage}`,
    summary: copy.summary,
    targetLanguage: profile.targetLanguage,
    sourceLanguage: profile.sourceLanguage,
    level: profile.level,
    objectives: [copy.objective],
    theory: [{
      id: `${prefix}-theory`,
      kind: "concept",
      title: copy.theoryTitle,
      body: copy.theoryBody,
    }],
    examples: [{
      id: `${prefix}-example`,
      source: target.drinkWater,
      translation: source.drinkWater,
      note: copy.explanation,
    }],
    glossary,
    sourceReferences: [{ id: `${prefix}-source`, kind: "note", title: `${copy.sourceTitle}: ${unitName}` }],
    questions,
    questionAlternates,
    createdAt: new Date().toISOString(),
  }, undefined, profile);
}
