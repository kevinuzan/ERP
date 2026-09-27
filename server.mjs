// server.mjs
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb'; // Adicionado ObjectId
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import Anthropic from '@anthropic-ai/sdk'; // yarn add @anthropic-ai/sdk

// --- CONFIGURAÇÕES BÁSICAS ---
const app = express();
const PORT = process.env.PORT || 3000;
const DB_NAME = "planejamento_financeiro";
const COLLECTION_NAME = "transactions";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let individualCollection;
let disneyCollection;
let consorcioCollection;
let chatCollection;
let appSettingsCollection;

// --- CLAUDE API (chat da aba Individual) ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CATEGORIAS_VALIDAS = ['Lazer', 'Alimentação', 'Transporte', 'Saúde', 'Trabalho', 'Outros'];

// Normaliza um nome de categoria pra comparação (minúsculo, sem acento, sem espaços nas pontas)
// evitando duplicatas tipo "Bebida" / "bebida" / "Bebidas ".
function normalizarCategoria(nome) {
    return (nome || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .toLowerCase();
}

// Dado um nome de categoria sugerido (pode ser novo) e a lista de categorias já existentes,
// retorna o nome já existente se houver um equivalente (case/acento-insensitive), ou o nome
// novo formatado em Title Case caso contrário. Nunca retorna string vazia.
function resolverCategoria(nomeSugerido, categoriasExistentes) {
    const sugerido = (nomeSugerido || '').trim();
    if (!sugerido) return 'Outros';
    const normalizado = normalizarCategoria(sugerido);
    const existente = categoriasExistentes.find(c => normalizarCategoria(c) === normalizado);
    if (existente) return existente;
    // Formata a categoria nova em Title Case (primeira letra de cada palavra maiúscula)
    return sugerido
        .toLowerCase()
        .split(/\s+/)
        .map(p => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');
}

// Busca as categorias que já existem nos lançamentos, combinando com as categorias "base".
// Usado tanto pro prompt do chat quanto pro endpoint que alimenta os <select> do front-end.
async function listarCategorias() {
    let categoriasDb = [];
    try {
        if (individualCollection) {
            categoriasDb = await individualCollection.distinct('category');
        }
    } catch (e) {
        console.error('Erro ao buscar categorias existentes:', e);
    }
    const todas = [...CATEGORIAS_VALIDAS];
    for (const c of categoriasDb) {
        if (c && !todas.some(t => normalizarCategoria(t) === normalizarCategoria(c))) {
            todas.push(c);
        }
    }
    return todas;
}
const OWNERS_VALIDOS = ['Kevin', 'Any', 'Conjunto'];

// --- FECHAMENTO DA FATURA (cartão fecha dia 25) ---
const CARD_CLOSING_DAY = 25;

// "Hoje" no fuso de São Paulo (UTC-3, sem horário de verão atualmente).
// Usamos os getters UTC sobre essa data já deslocada pra ler "dia/mês/ano locais" de forma simples.
function hojeEmSaoPaulo() {
    const agora = new Date();
    return new Date(agora.getTime() - 3 * 60 * 60 * 1000);
}

function cicloAtualKey(dataSp) {
    return `${dataSp.getUTCFullYear()}-${String(dataSp.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getEstadoFatura() {
    let estado = await appSettingsCollection.findOne({ _id: 'billing_cycle' });
    if (!estado) {
        estado = { _id: 'billing_cycle', overrideAtivo: false, overrideAno: null, overrideMes: null, ativadoNoCiclo: null };
        await appSettingsCollection.insertOne(estado);
    }

    // Se o calendário real já alcançou o mês de destino do override, ele deixa de ser necessário
    // (novos lançamentos já caem nesse mês naturalmente) — desativa sozinho.
    const hoje = hojeEmSaoPaulo();
    if (estado.overrideAtivo && estado.overrideAno === hoje.getUTCFullYear() && estado.overrideMes === hoje.getUTCMonth() + 1) {
        await appSettingsCollection.updateOne({ _id: 'billing_cycle' }, { $set: { overrideAtivo: false } });
        estado.overrideAtivo = false;
    }

    return estado;
}

// Decide a qual mês/ano um gasto deve ser contado (mesReferencia/anoReferencia),
// que pode ser diferente do mês/ano real da data da compra durante a janela de
// fechamento da fatura (dia 25 em diante), se o modo "próximo mês" estiver ativo.
// Só se aplica a lançamentos datados de HOJE (não mexe em parcelas futuras já datadas).
async function calcularReferencia(dataCompra) {
    const estado = await getEstadoFatura();
    const hoje = hojeEmSaoPaulo();
    const dataNoMesAtual = dataCompra.getUTCFullYear() === hoje.getUTCFullYear()
        && dataCompra.getUTCMonth() === hoje.getUTCMonth();

    if (estado.overrideAtivo && dataNoMesAtual) {
        return { anoReferencia: estado.overrideAno, mesReferencia: estado.overrideMes };
    }
    return { anoReferencia: dataCompra.getUTCFullYear(), mesReferencia: dataCompra.getUTCMonth() + 1 };
}

// Soma "meses" a uma referência ano/mês (mesBase 1-indexado), normalizando virada de ano.
function avancarReferencia(anoBase, mesBase, meses) {
    const totalMeses = (mesBase - 1) + meses;
    const anoReferencia = anoBase + Math.floor(totalMeses / 12);
    const mesReferencia = (totalMeses % 12) + 1;
    return { anoReferencia, mesReferencia };
}

// Decide a data (campo "date") de um lançamento a partir da referência já calculada. Se a
// referência é o mesmo mês/ano real de hoje, mantém a data/hora exata do lançamento. Se a
// referência aponta pra outro mês (ex: "vale pro mês seguinte" durante o fechamento da fatura),
// grava como dia 1 desse mês de referência — pra não aparecer com data de hoje num mês que não é o de hoje.
function dataParaReferencia(referencia, dataReal) {
    const hoje = hojeEmSaoPaulo();
    const referenciaEhMesRealAtual = referencia.anoReferencia === hoje.getUTCFullYear()
        && referencia.mesReferencia === hoje.getUTCMonth() + 1;
    if (referenciaEhMesRealAtual) {
        return dataReal;
    }
    return new Date(Date.UTC(referencia.anoReferencia, referencia.mesReferencia - 1, 1));
}
// Substitua esta string pela sua URI de conexão do MongoDB
const MONGO_URI = process.env.MONGO_PUBLIC_URL || "SUA_URI_LOCAL_DE_TESTE";

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// Servir arquivos estáticos (assumindo que o index.html está na raiz)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});


import cron from 'node-cron';
import webpush from 'web-push';

// 1. Configure as chaves que você gerou no passo anterior
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
console.log(publicVapidKey)
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
webpush.setVapidDetails('mailto:uzankevin93@gmail.com', publicVapidKey, privateVapidKey);

// 2. Array para guardar as inscrições (em produção, salve isso em uma collection no MongoDB)
let pushSubscriptions = [];

app.post('/api/subscribe', async (req, res) => {
    const subscription = req.body;
    try {
        const client = new MongoClient(MONGO_URI);
        const db = client.db(DB_NAME);
        const subsCollection = db.collection('subscriptions');

        // Evita duplicados (usa o endpoint como ID único)
        await subsCollection.updateOne(
            { endpoint: subscription.endpoint },
            { $set: subscription },
            { upsert: true }
        );

        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function verificarVencimentos() {
    try {
        const client = new MongoClient(MONGO_URI);
        const db = client.db(DB_NAME);
        const transactionsColl = db.collection('transactions');
        const subsCollection = db.collection('subscriptions');

        // Pega a data de HOJE (zerando horas para comparar apenas o dia)
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        const despesas = await transactionsColl.find({ type: 'DESPESA' }).toArray();
        const assinaturas = await subsCollection.find().toArray();

        if (assinaturas.length === 0) return;

        for (const despesa of despesas) {
            const dataVenc = new Date(despesa.date);
            dataVenc.setHours(0, 0, 0, 0);

            // Calcula a diferença em milissegundos e converte para dias
            const diffTime = dataVenc.getTime() - hoje.getTime();
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

            let mensagem = "";
            if (diffDays === 2) mensagem = `⏰ Conta chegando! "${despesa.description}" R$ ${despesa.value} vence em 2 dias.`;
            else if (diffDays === 1) mensagem = `⚠️ Atenção: "${despesa.description}" R$ ${despesa.value} vence amanhã!`;
            else if (diffDays === 0) mensagem = `💸 Vence HOJE: "${despesa.description}" R$ ${despesa.value}.`;

            console.log(mensagem)
            if (mensagem) {
                const payload = JSON.stringify({
                    title: "Alerta de Vencimento",
                    body: mensagem,
                    url: "/"
                });
                // console.log(mensagem)
                // Dispara para todos os dispositivos
                // assinaturas.forEach(sub => {
                //     webpush.sendNotification(sub, payload).catch(err => {
                //         if (err.statusCode === 410) {
                //             subsCollection.deleteOne({ endpoint: sub.endpoint });
                //         }
                //     });
                // });
                const envios = assinaturas.map(sub =>
                    webpush.sendNotification(sub, payload).catch(err => {
                        // Se a notificação falhar porque o token expirou (erro 410), removemos do banco
                        if (err.statusCode === 410) {
                            subsCollection.deleteOne({ endpoint: sub.endpoint });
                        }
                    })
                );
                await Promise.all(envios);
            }
        }
        // console.log("✅ Varredura de 17:15 finalizada.");
    } catch (error) {
        console.error("❌ Erro no processamento do cron:", error);
    }
}

// 4. Agenda para rodar todo dia às 08:00 da manhã
cron.schedule('30 11 * * *', () => {
    console.log("Executando verificação de vencimentos...");
    verificarVencimentos();
});

// 4. Rota para você disparar a mensagem (O GATILHO)
app.get('/api/send-notif', (req, res) => {
    const payload = JSON.stringify({ title: "Finanças App", body: "Você recebeu uma atualização!" });

    // Manda para todo mundo que acessou o site e aceitou o push
    Promise.all(subscriptions.map(sub => webpush.sendNotification(sub, payload)))
        .then(() => res.json({ success: true }))
        .catch(err => res.status(500).json({ error: err.stack }));
});
app.get('/api/test-push', async (req, res) => {
    try {
        const client = new MongoClient(MONGO_URI);
        const db = client.db(DB_NAME);
        const subsCollection = db.collection('subscriptions');

        // 1. Pega todas as assinaturas guardadas no banco
        const allSubs = await subsCollection.find().toArray();

        console.log(`Disparando para ${allSubs.length} dispositivos cadastrados.`);
        await verificarVencimentos();
        // const payload = JSON.stringify({
        //     title: "Teste de Notificação",
        //     body: "Se você recebeu isso, o banco de dados está funcionando!",
        //     url: "/"
        // });

        // // 2. Envia para cada uma delas
        // const envios = allSubs.map(sub =>
        //     webpush.sendNotification(sub, payload).catch(err => {
        //         // Se a notificação falhar porque o token expirou (erro 410), removemos do banco
        //         if (err.statusCode === 410) {
        //             subsCollection.deleteOne({ endpoint: sub.endpoint });
        //         }
        //     })
        // );

        // await Promise.all(envios);
        res.json({ success: `Disparado para ${allSubs.length} dispositivos!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- CONEXÃO PERSISTENTE COM O MONGODB ---
let transactionsCollection;

async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        console.log(`URI de Conexão: ${MONGO_URI.substring(0, 30)}...`); // Log da URI truncada
        await client.connect();
        const db = client.db(DB_NAME);
        transactionsCollection = db.collection(COLLECTION_NAME);
        individualCollection = db.collection("individual_expenses"); // Nova coleção
        disneyCollection = db.collection("disney_expenses");
        // Dentro da função de conexão ao banco:
        consorcioCollection = db.collection("consorcio_config");
        chatCollection = db.collection("chat_messages");
        appSettingsCollection = db.collection("app_settings");
        console.log(`Conectado ao MongoDB: DB '${DB_NAME}'`);

        app.listen(PORT, () => {
            console.log(`Servidor API rodando em http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("ERRO FATAL: Falha ao conectar ao Banco de Dados.", error);
        process.exit(1);
    }
}

// 💡 NOVO: Mecanismo de sincronização para garantir que a replicação não seja executada simultaneamente
let isReplicating = false;
let replicationPromise = Promise.resolve(0);

/**
 * Cria transações recorrentes no DB para o mês/ano solicitado, 
 * baseando-se nas transações recorrentes do mês anterior.
 */
async function replicateRecurringTransactions(year, month) {
    if (!transactionsCollection) return 0;

    // Se já estiver replicando, espere a promessa atual ser resolvida
    if (isReplicating) {
        return replicationPromise;
    }

    // Marca como em andamento e armazena a promessa de execução
    isReplicating = true;
    replicationPromise = (async () => {
        try {
            // 🌟 CORREÇÃO DE DATA: Define o mês atual em UTC
            const targetStartDate = new Date(Date.UTC(year, month - 1, 1));
            const targetEndDate = new Date(Date.UTC(year, month, 1));

            // 1. BUSCA: Transações recorrentes ORIGINAIS (ROOT) inseridas em qualquer mês anterior.
            // 💡 NOVO FILTRO: isSuperseded: { $ne: true } -> Garante que o modelo não foi substituído
            const recurringModels = await transactionsCollection.find({
                date: { $lt: targetStartDate }, // Transações anteriores ao mês alvo
                isRecurrent: true,
                replicatedFromId: { $exists: false }, // APENAS modelos originais (ROOT)
                isSuperseded: { $ne: true } // Ignora modelos que foram desativados
            }).toArray();

            if (recurringModels.length === 0) {
                return 0;
            }

            // 💡 CHECAGEM DE EXISTÊNCIA: Pré-busca de todas as réplicas existentes no mês alvo.
            const existingReplicas = await transactionsCollection.find({
                date: { $gte: targetStartDate, $lt: targetEndDate },
                isRecurrent: true,
                replicatedFromId: { $exists: true }
            }).project({ replicatedFromId: 1 }).toArray();

            const existingRootIds = new Set(existingReplicas.map(r => r.replicatedFromId.toString()));

            // 2. REPLICA: Cria novas transações para o mês alvo
            const transactionsToInsert = [];

            for (const model of recurringModels) {

                // CHECAGEM RÁPIDA: Se o ID do modelo ROOT já está na lista de réplicas, pule.
                if (existingRootIds.has(model._id.toString())) {
                    continue;
                }

                // --- 3. Geração da nova data ---

                // 1. Obter o dia do mês original de forma segura em UTC
                const dayOfMonth = model.date.getUTCDate();

                // 2. Calcular o número de dias no mês ALVO
                const daysInTargetMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

                // 3. Escolher o dia mais seguro: o dia original OU o último dia do mês alvo (Math.min)
                const safeDay = Math.min(dayOfMonth, daysInTargetMonth);

                // 4. Criar a data final em UTC.
                const finalDate = new Date(Date.UTC(
                    year,
                    month - 1, // Mês alvo (0-indexado)
                    safeDay,   // Dia seguro (1-31)
                    model.date.getUTCHours(),
                    model.date.getUTCMinutes()
                ));

                // --- 4. Montagem da Transação ---

                // Clona o objeto, copiando apenas os campos necessários e definindo replicatedFromId
                const newTransaction = {
                    description: model.description,
                    value: model.value,
                    type: model.type,
                    category: model.category,
                    isRecurrent: model.isRecurrent,
                    // -------------------------------------------------------------
                    date: finalDate, // Data corrigida
                    replicatedFromId: model._id, // Aponta para o modelo ROOT
                };

                transactionsToInsert.push(newTransaction);
            }

            if (transactionsToInsert.length > 0) {
                await transactionsCollection.insertMany(transactionsToInsert);
            }

            return transactionsToInsert.length;
        } catch (error) {
            console.error("Erro na replicação de transações:", error);
            return 0;
        } finally {
            // Desmarca a flag de sincronização (IMPORTANTE)
            isReplicating = false;
        }
    })();

    // Retorna a promessa para que ambas as rotas aguardem a conclusão
    return replicationPromise;
}

// Inicia o servidor e a conexão
connectDB();


// --- ROTA 1: Resumo Mensal (GET /api/summary) ---
// ... (código resumido, não alterado) ...
app.get('/api/summary', async (req, res) => {
    if (!transactionsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    const { year, month } = req.query;
    if (!year || !month) {
        return res.status(400).json({ error: "Parâmetros 'year' e 'month' (numéricos) são obrigatórios." });
    }

    const y = parseInt(year);
    const m = parseInt(month);

    // 1. Checa e cria transações recorrentes antes de agregar (agora sincronizado)
    const insertedCount = await replicateRecurringTransactions(y, m);
    if (insertedCount > 0) {
        console.log(`[Recorrência] Inseridas ${insertedCount} transações para ${m}/${y}`);
    }

    // 2. Define o intervalo de datas em UTC para a busca (do 1º dia do mês até o 1º dia do próximo mês)
    const startDate = new Date(Date.UTC(y, m - 1, 1));
    const endDate = new Date(Date.UTC(y, m, 1));

    try {
        // --- AGGREGATION PIPELINE ---
        const summary = await transactionsCollection.aggregate([
            { $match: { date: { $gte: startDate, $lt: endDate } } },
            { $group: { _id: { type: "$type", category: "$category" }, totalValue: { $sum: "$value" } } },
            {
                $group: {
                    _id: "$_id.type",
                    total: { $sum: "$totalValue" },
                    breakdown: { $push: { category: "$_id.category", total: "$totalValue" } },
                }
            },
            { $project: { _id: 0, type: "$_id", total: 1, breakdown: 1 } }
        ]).toArray();

        // Calcula o Saldo
        const receitas = summary.find(s => s.type === 'RECEITA')?.total || 0;
        const despesas = summary.find(s => s.type === 'DESPESA')?.total || 0;
        const saldo = receitas - despesas;


        res.json({
            month: m,
            year: y,
            data: summary,
            saldo: saldo,
        });

    } catch (error) {
        console.error("Erro na Aggregation Pipeline:", error);
        res.status(500).json({ error: "Erro interno do servidor ao gerar o resumo." });
    }
});
// Rota para editar um gasto individual existente
app.put('/api/individual/:id', async (req, res) => {
    try {
        const { description, value, owner, date, category } = req.body;
        const dataCompra = new Date(date);
        // Edição é uma correção explícita do usuário: usa o mês da própria data escolhida,
        // sem aplicar o override de "próximo mês" (esse só vale pra lançamentos novos "de agora").
        await individualCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            {
                $set: {
                    description,
                    value: parseFloat(value),
                    owner,
                    date: dataCompra,
                    category,
                    anoReferencia: dataCompra.getUTCFullYear(),
                    mesReferencia: dataCompra.getUTCMonth() + 1,
                }
            }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro ao atualizar" });
    }
});

app.post('/api/individual', async (req, res) => {
    try {
        const { description, value, owner, date, category } = req.body;
        const dataCompra = new Date(date);
        const referencia = await calcularReferencia(dataCompra);
        await individualCollection.insertOne({
            description,
            value: parseFloat(value),
            owner,
            date: dataCompra, // O Mongo salvará a data exata escolhida
            category,
            ...referencia,
        });
        res.status(201).json({ success: true, ...referencia });
    } catch (error) {
        res.status(500).json({ error: "Erro ao salvar" });
    }
});

app.get('/api/individual/list', async (req, res) => {
    const { month, year } = req.query;
    const mesReferencia = parseInt(month) + 1; // "month" chega 0-indexado do front-end
    const anoReferencia = parseInt(year);
    const startDate = new Date(Date.UTC(year, month, 1));
    const endDate = new Date(Date.UTC(year, parseInt(month) + 1, 1));

    try {
        // Prioriza o campo de referência (que respeita o fechamento da fatura).
        // Registros antigos, gravados antes dessa mudança, não têm esse campo — pra esses,
        // cai de volta pro mês da própria data da compra.
        const expenses = await individualCollection.find({
            $or: [
                { anoReferencia, mesReferencia },
                { anoReferencia: { $exists: false }, date: { $gte: startDate, $lt: endDate } },
            ],
        }).sort({ date: -1 }).toArray();
        res.json(expenses);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar" });
    }
});

app.get('/api/individual/categories', async (req, res) => {
    try {
        const categorias = await listarCategorias();
        res.json(categorias);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar categorias" });
    }
});

// --- FECHAMENTO DA FATURA: status e ativação do modo "próximo mês" ---
app.get('/api/billing-status', async (req, res) => {
    if (!appSettingsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }
    try {
        const estado = await getEstadoFatura();
        const hoje = hojeEmSaoPaulo();
        const cicloAtual = cicloAtualKey(hoje);
        // Mostra o banner todo dia entre o fechamento e a virada do mês, enquanto ninguém tiver
        // ativado o modo "próximo mês". O "não mostrar novamente" é tratado só no front-end
        // (por aparelho), então aqui não suprimimos o banner por isso.
        const showBanner = hoje.getUTCDate() >= CARD_CLOSING_DAY && !estado.overrideAtivo;

        const proximo = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 1));

        res.json({
            showBanner,
            cicloAtual,
            overrideAtivo: estado.overrideAtivo,
            overrideAno: estado.overrideAno,
            overrideMes: estado.overrideMes,
            proximoAno: proximo.getUTCFullYear(),
            proximoMes: proximo.getUTCMonth() + 1,
        });
    } catch (error) {
        console.error("Erro ao checar status da fatura:", error);
        res.status(500).json({ error: "Erro ao checar status da fatura." });
    }
});

app.post('/api/billing-toggle', async (req, res) => {
    if (!appSettingsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }
    try {
        const hoje = hojeEmSaoPaulo();
        const proximo = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 1));
        const cicloAtual = cicloAtualKey(hoje);

        await appSettingsCollection.updateOne(
            { _id: 'billing_cycle' },
            {
                $set: {
                    overrideAtivo: true,
                    overrideAno: proximo.getUTCFullYear(),
                    overrideMes: proximo.getUTCMonth() + 1,
                    ativadoNoCiclo: cicloAtual,
                },
            },
            { upsert: true }
        );

        res.json({
            success: true,
            overrideAno: proximo.getUTCFullYear(),
            overrideMes: proximo.getUTCMonth() + 1,
        });
    } catch (error) {
        console.error("Erro ao ativar modo próximo mês:", error);
        res.status(500).json({ error: "Erro ao ativar modo próximo mês." });
    }
});

app.delete('/api/individual/:id', async (req, res) => {
    try {
        await individualCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro ao excluir" });
    }
});

// --- ROTAS API CONSÓRCIO ---

// Salvar ou Atualizar
app.post('/api/consorcios', async (req, res) => {
    try {
        const client = new MongoClient(MONGO_URI);
        const db = client.db(DB_NAME);
        const col = db.collection('consorcios');
        const data = req.body;
        if (data._id) {
            // Se tem ID, é uma edição
            const id = data._id;
            delete data._id; // Remove o ID do corpo para não conflitar no Mongo
            await col.updateOne({ _id: new ObjectId(id) }, { $set: data });
            res.json({ _id: id, ...data });
        } else {
            // Se não tem ID, é um novo
            const result = await col.insertOne(data);
            res.json({ _id: result.insertedId, ...data });
        }
    } catch (error) {
        res.status(500).json({ error: "Erro ao salvar consórcio" });
    }
});

app.get('/api/consorcios', async (req, res) => {
    const client = new MongoClient(MONGO_URI);
    const db = client.db(DB_NAME);
    const lista = await db.collection('consorcios').find().toArray();
    res.json(lista);
});

app.delete('/api/consorcios/:id', async (req, res) => {
    const client = new MongoClient(MONGO_URI);
    const db = client.db(DB_NAME);
    await db.collection('consorcios').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ message: "Removido" });
});


// Rotas Disney
app.get('/api/disney', async (req, res) => {
    const expenses = await disneyCollection.find().sort({ date: -1 }).toArray();
    res.json(expenses);
});

app.post('/api/disney', async (req, res) => {
    const newExpense = { ...req.body, date: new Date(req.body.date) };
    await disneyCollection.insertOne(newExpense);
    res.status(201).json({ success: true });
});

app.put('/api/disney/:id', async (req, res) => {
    const id = req.params.id;
    const update = { ...req.body, date: new Date(req.body.date) };
    delete update._id;
    await disneyCollection.updateOne({ _id: new ObjectId(id) }, { $set: update });
    res.json({ success: true });
});

app.delete('/api/disney/:id', async (req, res) => {
    await disneyCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
});

// --- ROTA 2: Detalhamento por Categoria (GET /api/breakdown) ---
// ... (código resumido, não alterado) ...
app.get('/api/breakdown', async (req, res) => {
    if (!transactionsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    const { year, month } = req.query;
    if (!year || !month) {
        return res.status(400).json({ error: "Parâmetros 'year' e 'month' são obrigatórios." });
    }

    const y = parseInt(year);
    const m = parseInt(month);

    // 1. A REPLICAÇÃO JÁ É FEITA NA ROTA /api/summary, então apenas buscamos

    // 2. Define o intervalo de datas em UTC para a busca
    const startDate = new Date(Date.UTC(y, m - 1, 1));
    const endDate = new Date(Date.UTC(y, m, 1));

    try {
        const breakdown = await transactionsCollection.aggregate([
            {
                $match: {
                    date: { $gte: startDate, $lt: endDate },
                    type: 'DESPESA', // Filtra apenas despesas para o gráfico
                }
            },
            {
                $group: {
                    _id: "$category",
                    total: { $sum: "$value" },
                }
            },
            { $sort: { total: -1 } }, // Ordena pelo maior valor
            { $project: { _id: 0, category: "$_id", total: 1 } }
        ]).toArray();

        res.json(breakdown);

    } catch (error) {
        console.error("Erro na Aggregation Pipeline (Breakdown):", error);
        res.status(500).json({ error: "Erro interno do servidor ao gerar o detalhamento." });
    }
});


// --- ROTA 3: Inserção de Transação (POST /api/transactions) ---
app.post('/api/transactions', async (req, res) => {
    if (!transactionsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    const { description, value, date, type, category, isRecurrent } = req.body;

    if (!description || !value || !date || !type || !category) {
        return res.status(400).json({ error: "Todos os campos são obrigatórios." });
    }

    // 🌟 CORREÇÃO DE DATA: Garante que a data é salva na meia-noite UTC (T00:00:00Z)
    // Isso garante que a transação modelo seja encontrada pelo filtro de recorrência.
    const dateOnly = date.substring(0, 10); // Pega apenas 'AAAA-MM-DD'
    const utcDate = new Date(dateOnly + 'T00:00:00Z');

    const transaction = {
        description,
        value: parseFloat(value),
        date: utcDate,
        type: type.toUpperCase(),
        category,
        isRecurrent: !!isRecurrent,
    };

    try {
        const result = await transactionsCollection.insertOne(transaction);
        res.status(201).json({
            message: "Transação inserida com sucesso!",
            _id: result.insertedId
        });
    } catch (error) {
        console.error("Erro ao inserir transação:", error);
        res.status(500).json({ error: "Erro ao salvar transação no DB." });
    }
});


// --- ROTA 3.1: Webhook do MacroDroid (Notificações do Santander) ---
// Recebe o texto bruto extraído da notificação de compra e grava como transação.
// Protegida por uma chave simples (evita que qualquer um na internet insira transações falsas).
const SANTANDER_WEBHOOK_SECRET = process.env.SANTANDER_WEBHOOK_SECRET || "troque-essa-chave";

// Extrai os campos da notificação de compra do Santander a partir do texto bruto.
// Cobre pelo menos dois formatos conhecidos:
// "Compra no cartão final 7324, de R$ 17,99, em 25/09/26, às 19:23, em ALTAAPROVACAO, aprovada."
// "Compra internacional aprovada no cartão final 9202, de R$ 30,00, em 25/09/26, às 21:51, em BOARDGAMEARENA."
// (no 2º formato o status vem no meio da frase, não no final)
function parseNotificacaoSantander(texto) {
    if (!texto) return null;

    // Valor no formato brasileiro: "17,99" ou "1.234,50" (sempre com 2 casas decimais após a vírgula)
    // O status no final (", aprovada.") é opcional, porque em alguns formatos ele aparece
    // antes de "no cartão final" em vez de no fim da frase.
    const regex = /cart[ãa]o final\s*(\d{3,4}).*?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2}).*?em\s*(\d{2}\/\d{2}\/\d{2,4}).*?[àa]s\s*(\d{2}:\d{2}).*?em\s+(.+?)(?:,\s*(aprovada|cancelada|negada))?\s*\.?\s*$/is;
    const match = texto.match(regex);
    if (!match) return null;

    const [, cartaoFinal, valorStr, dataStr, hora, estabelecimento, statusFinal] = match;

    // Se o status não veio no final, procura em qualquer lugar do texto
    // (cobre "Compra internacional aprovada no cartão...").
    let status = statusFinal;
    if (!status) {
        const statusMatch = texto.match(/\b(aprovada|cancelada|negada)\b/i);
        status = statusMatch ? statusMatch[1] : null;
    }
    if (!status) return null;

    return {
        cartaoFinal,
        valor: valorStr,
        data: dataStr,
        hora,
        estabelecimento: estabelecimento.trim(),
        status: status.toLowerCase(),
    };
}

app.post('/api/santander-webhook', async (req, res) => {
    if (!individualCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    // --- Autenticação simples via header ---
    const chaveRecebida = req.get('x-webhook-secret');
    if (chaveRecebida !== SANTANDER_WEBHOOK_SECRET) {
        return res.status(401).json({ error: "Não autorizado." });
    }

    // O MacroDroid manda o texto cru da notificação (título + corpo) — o parsing é feito aqui.
    const { titulo, texto } = req.body;
    const textoCompleto = [titulo, texto].filter(Boolean).join(' ');

    if (!textoCompleto) {
        return res.status(400).json({ error: "Campo 'texto' (ou 'titulo') é obrigatório.", body_recebido: req.body });
    }

    const dados = parseNotificacaoSantander(textoCompleto);

    if (!dados) {
        // Não conseguiu reconhecer o formato (pode ser outro tipo de notificação, tipo PIX).
        // Retorna 200 pra não gerar retentativas no MacroDroid, mas registra o que veio pra análise.
        console.warn("Notificação Santander não reconhecida:", textoCompleto);
        return res.status(200).json({
            message: "Notificação recebida, mas não reconhecida como compra no cartão. Ignorada.",
            texto_recebido: textoCompleto,
        });
    }

    // Normaliza o valor ("17,99" -> 17.99)
    const valorNumerico = parseFloat(dados.valor.replace(/\./g, '').replace(',', '.'));

    // Normaliza a data "DD/MM/AA" ou "DD/MM/AAAA"
    const [dia, mes, anoBruto] = dados.data.split('/');
    const ano = anoBruto.length === 2 ? `20${anoBruto}` : anoBruto;
    const dataTransacao = new Date(Date.UTC(parseInt(ano), parseInt(mes) - 1, parseInt(dia)));

    // Compra negada: nenhum dinheiro se moveu, não vira transação.
    if (dados.status === 'negada') {
        return res.status(200).json({ message: "Compra negada, ignorada (nenhum valor movimentado)." });
    }

    // A aba "Individual" não tem campo de tipo (RECEITA/DESPESA) — tudo é lançado como "value".
    // Compra aprovada -> valor positivo (despesa). Compra cancelada (estorno de uma aprovada
    // anterior) -> valor NEGATIVO, pra abater da soma do mês sem precisar achar e apagar o lançamento antigo.
    const valorFinal = dados.status === 'cancelada' ? -valorNumerico : valorNumerico;
    const descricao = dados.status === 'cancelada'
        ? `Estorno - ${dados.estabelecimento}`
        : dados.estabelecimento;

    const referenciaSantander = await calcularReferencia(dataTransacao);
    const expense = {
        description: descricao,
        value: valorFinal,
        owner: 'Conjunto',
        category: 'Outros',
        date: dataTransacao,
        origem: 'macrodroid-santander',
        cartaoFinal: dados.cartaoFinal,
        horaCompra: dados.hora,
        textoOriginal: textoCompleto,
        ...referenciaSantander,
    };

    try {
        const result = await individualCollection.insertOne(expense);
        res.status(201).json({
            message: "Gasto do Santander registrado na aba Individual com sucesso!",
            _id: result.insertedId,
            gasto: expense,
        });
    } catch (error) {
        console.error("Erro ao inserir gasto do Santander:", error);
        res.status(500).json({ error: "Erro ao salvar gasto no DB." });
    }
});


// --- CHAT DA ABA INDIVIDUAL (Claude API) ---
// Duas ferramentas: "registrar_gasto" (quando a mensagem descreve uma compra) e
// "consultar_gastos" (quando é uma pergunta sobre os gastos já lançados).
const CHAT_TOOLS = [
    {
        name: 'registrar_gasto',
        description: 'Registra um novo gasto quando a mensagem do usuário descreve uma compra/despesa que acabou de acontecer. Exemplos: "Monster 12,99", "Uber pro trabalho 23,40", "Almoço Stone 54,50 conjunto".',
        input_schema: {
            type: 'object',
            properties: {
                description: { type: 'string', description: 'Descrição curta do gasto (produto, serviço ou estabelecimento).' },
                value: { type: 'number', description: 'Valor do gasto em reais, sempre um número positivo (ex: 12.99).' },
                category: { type: 'string', description: 'Categoria que melhor descreve o gasto. Reutilize uma categoria já existente sempre que fizer sentido; só crie um nome novo (curto, Title Case, ex: "Bebida") se nenhuma categoria existente descrever bem o gasto.' },
                owner: {
                    type: 'string',
                    enum: OWNERS_VALIDOS,
                    description: 'Só inclua este campo se o usuário mencionar EXPLICITAMENTE um desses nomes na mensagem (ex: "conjunto", "Kevin", "Any"). Se não houver menção explícita, NÃO inclua o campo.',
                },
            },
            required: ['description', 'value', 'category'],
        },
    },
    {
        name: 'registrar_gasto_parcelado',
        description: 'Registra uma compra PARCELADA em várias vezes, quando a mensagem menciona explicitamente parcelamento. Exemplos: "compra parcelada em 10 vezes parcela 45,90 reais - Notebook", "TV 12x de 150,00", "Celular parcelado em 3x de 200". Cria um lançamento em cada um dos meses seguintes, um por parcela.',
        input_schema: {
            type: 'object',
            properties: {
                description: { type: 'string', description: 'Descrição do produto/serviço comprado.' },
                installments: { type: 'integer', description: 'Número de parcelas (ex: 10).' },
                installmentValue: { type: 'number', description: 'Valor de CADA parcela em reais — não o valor total da compra.' },
                category: { type: 'string', description: 'Categoria que melhor descreve o gasto. Reutilize uma categoria já existente sempre que fizer sentido; só crie um nome novo (curto, Title Case, ex: "Bebida") se nenhuma categoria existente descrever bem o gasto.' },
                owner: {
                    type: 'string',
                    enum: OWNERS_VALIDOS,
                    description: 'Só inclua este campo se o usuário mencionar EXPLICITAMENTE um desses nomes na mensagem. Se não houver menção explícita, NÃO inclua o campo.',
                },
            },
            required: ['description', 'installments', 'installmentValue', 'category'],
        },
    },
    {
        name: 'consultar_gastos',
        description: 'Usado quando a mensagem é uma pergunta ou pedido de relatório sobre os gastos já registrados. Exemplos: "no que eu mais gastei esse mês", "quanto gastei em Alimentação", "resumo do mês passado".',
        input_schema: {
            type: 'object',
            properties: {
                periodo: {
                    type: 'string',
                    enum: ['mes_atual', 'mes_anterior', 'ultimos_30_dias', 'ano_atual', 'tudo'],
                    description: 'Período a que a pergunta se refere. Use "mes_atual" como padrão se não for especificado.',
                },
            },
            required: [],
        },
    },
];

function intervaloDoPeriodo(periodo) {
    const agora = new Date();
    const anoAtual = agora.getUTCFullYear();
    const mesAtual = agora.getUTCMonth(); // 0-indexado

    switch (periodo) {
        case 'mes_anterior': {
            const start = new Date(Date.UTC(anoAtual, mesAtual - 1, 1));
            const end = new Date(Date.UTC(anoAtual, mesAtual, 1));
            return { start, end };
        }
        case 'ultimos_30_dias': {
            const end = new Date(Date.UTC(anoAtual, mesAtual, agora.getUTCDate() + 1));
            const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
            return { start, end };
        }
        case 'ano_atual': {
            const start = new Date(Date.UTC(anoAtual, 0, 1));
            const end = new Date(Date.UTC(anoAtual + 1, 0, 1));
            return { start, end };
        }
        case 'tudo':
            return { start: new Date(Date.UTC(2000, 0, 1)), end: new Date(Date.UTC(anoAtual + 1, 0, 1)) };
        case 'mes_atual':
        default: {
            const start = new Date(Date.UTC(anoAtual, mesAtual, 1));
            const end = new Date(Date.UTC(anoAtual, mesAtual + 1, 1));
            return { start, end };
        }
    }
}

// Monta o filtro do Mongo pra "consultar_gastos". Pra mês atual/anterior, usa o mesmo campo de
// "competência" (mesReferencia/anoReferencia) que a aba Individual usa — assim o chat responde
// baseado na MESMA visão de mês que aparece na tela, respeitando o fechamento da fatura.
// Pra períodos que abrangem vários meses (últimos 30 dias, ano, tudo), usa a data real mesmo.
function filtroPorPeriodo(periodo, start, end) {
    if (periodo === 'mes_atual' || periodo === 'mes_anterior' || !periodo) {
        const anoReferencia = start.getUTCFullYear();
        const mesReferencia = start.getUTCMonth() + 1;
        return {
            $or: [
                { anoReferencia, mesReferencia },
                { anoReferencia: { $exists: false }, date: { $gte: start, $lt: end } },
            ],
        };
    }
    return { date: { $gte: start, $lt: end } };
}

function montarChatSystemPrompt(categoriasExistentes) {
    return `Você é o assistente do app financeiro pessoal de um casal (Kevin e Any/Ana), que também lança gastos como "Conjunto" quando é dividido.
Categorias já existentes (use uma destas sempre que fizer sentido): ${categoriasExistentes.join(', ')}.
Se o gasto não se encaixa bem em nenhuma categoria existente, invente uma categoria nova, curta e em Title Case (ex: "Bebida", "Pet", "Assinaturas"). Evite criar uma categoria nova que seja praticamente sinônima de uma já existente (ex: não crie "Comida" se já existe "Alimentação").
Donos válidos: ${OWNERS_VALIDOS.join(', ')}.
Data de hoje: ${new Date().toISOString().slice(0, 10)}.

Quando a mensagem do usuário descrever uma compra/gasto recém-feito À VISTA, chame a ferramenta registrar_gasto.
Quando a mensagem mencionar EXPLICITAMENTE parcelamento (palavras como "parcelado", "parcela", "vezes", "Nx de", "em N vezes"), chame a ferramenta registrar_gasto_parcelado em vez de registrar_gasto.
Quando a mensagem for uma pergunta ou pedido de resumo/relatório sobre os gastos, chame a ferramenta consultar_gastos.
Se a mensagem contiver VÁRIOS gastos (por exemplo, uma lista com um item por linha, cada um com sua própria descrição e valor, como "- refrigerante: R$ 12,73"), chame a ferramenta registrar_gasto (ou registrar_gasto_parcelado, se for o caso) UMA VEZ PARA CADA item da lista, todas as chamadas na mesma resposta — nunca registre só o primeiro item e ignore o resto.
Se a mensagem não for nenhuma dessas coisas (ex: um cumprimento), responda normalmente em texto, de forma breve.`;
}

app.post('/api/chat/message', async (req, res) => {
    if (!chatCollection || !individualCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor." });
    }

    const { message, defaultOwner, refMes, refAno } = req.body;
    if (!message || !message.trim()) {
        return res.status(400).json({ error: "Campo 'message' é obrigatório." });
    }
    const ownerPadrao = OWNERS_VALIDOS.includes(defaultOwner) ? defaultOwner : 'Conjunto';

    // Mês/ano que estão sendo exibidos na tela (enviados pelo front-end). Gastos lançados pelo
    // chat devem contar pra esse mês — o mesmo mês que o usuário está vendo, seja porque ele
    // navegou manualmente ou porque ativou "valer para o mês seguinte" (que já muda a tela pra
    // o próximo mês). Se não vier (ex: cliente antigo em cache), cai de volta na lógica antiga
    // baseada na data real + estado do fechamento da fatura.
    const mesRefValido = Number.isInteger(parseInt(refMes)) && parseInt(refMes) >= 1 && parseInt(refMes) <= 12;
    const anoRefValido = Number.isInteger(parseInt(refAno)) && parseInt(refAno) > 2000;
    const referenciaVigente = (mesRefValido && anoRefValido)
        ? { anoReferencia: parseInt(refAno), mesReferencia: parseInt(refMes) }
        : null;

    try {
        await chatCollection.insertOne({ role: 'user', content: message, owner: ownerPadrao, date: new Date() });

        const categoriasExistentes = await listarCategorias();

        const primeiraResposta = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 4096,
            system: montarChatSystemPrompt(categoriasExistentes),
            tools: CHAT_TOOLS,
            messages: [{ role: 'user', content: message }],
        });

        const toolUses = primeiraResposta.content.filter(bloco => bloco.type === 'tool_use');
        const gastoToolUses = toolUses.filter(t => t.name === 'registrar_gasto' || t.name === 'registrar_gasto_parcelado');
        const consultaToolUse = toolUses.find(t => t.name === 'consultar_gastos');

        let reply;
        let acao = 'chat';
        let detalhes = null;

        if (gastoToolUses.length > 0) {
            // Categorias já resolvidas nesta mesma mensagem, pra que dois itens parecidos (ex: duas
            // "bebidas" na mesma lista) caiam exatamente na mesma categoria nova, em vez de duas variações.
            const categoriasDaSessao = [...categoriasExistentes];
            const linhasResposta = [];
            const detalhesItens = [];

            for (const toolUse of gastoToolUses) {
                if (toolUse.name === 'registrar_gasto') {
                    const { description, value, category } = toolUse.input;
                    const owner = OWNERS_VALIDOS.includes(toolUse.input.owner) ? toolUse.input.owner : ownerPadrao;
                    const categoriaFinal = resolverCategoria(category, categoriasDaSessao);
                    if (!categoriasDaSessao.some(c => normalizarCategoria(c) === normalizarCategoria(categoriaFinal))) {
                        categoriasDaSessao.push(categoriaFinal);
                    }

                    const dataGasto = new Date();
                    const referenciaChat = referenciaVigente || await calcularReferencia(dataGasto);
                    const gasto = {
                        description,
                        value: Math.abs(parseFloat(value)),
                        owner,
                        category: categoriaFinal,
                        date: dataParaReferencia(referenciaChat, dataGasto),
                        origem: 'chat-claude',
                        ...referenciaChat,
                    };
                    const result = await individualCollection.insertOne(gasto);

                    detalhesItens.push({ tipo: 'gasto', _id: result.insertedId, ...gasto });
                    linhasResposta.push(`✅ *${description}* — R$ ${gasto.value.toFixed(2).replace('.', ',')} (${categoriaFinal}, ${owner})`);

                } else if (toolUse.name === 'registrar_gasto_parcelado') {
                    const { description, category } = toolUse.input;
                    const installments = Math.max(1, parseInt(toolUse.input.installments) || 1);
                    const installmentValue = Math.abs(parseFloat(toolUse.input.installmentValue));
                    const owner = OWNERS_VALIDOS.includes(toolUse.input.owner) ? toolUse.input.owner : ownerPadrao;
                    const categoriaFinal = resolverCategoria(category, categoriasDaSessao);
                    if (!categoriasDaSessao.some(c => normalizarCategoria(c) === normalizarCategoria(categoriaFinal))) {
                        categoriasDaSessao.push(categoriaFinal);
                    }

                    const agora = new Date();
                    const gastosParcelados = [];
                    for (let i = 0; i < installments; i++) {
                        const dataParcela = new Date(agora.getTime());
                        dataParcela.setUTCMonth(dataParcela.getUTCMonth() + i);
                        // A 1ª parcela conta pro mês vigente (igual a um gasto à vista); as seguintes
                        // avançam mês a mês a partir dali — sempre baseado no mês vigente, não na data real.
                        const referenciaParcela = referenciaVigente
                            ? avancarReferencia(referenciaVigente.anoReferencia, referenciaVigente.mesReferencia, i)
                            : await calcularReferencia(dataParcela);
                        gastosParcelados.push({
                            description: installments > 1 ? `${description} (${i + 1}/${installments})` : description,
                            value: installmentValue,
                            owner,
                            category: categoriaFinal,
                            date: dataParaReferencia(referenciaParcela, dataParcela),
                            origem: 'chat-claude',
                            ...referenciaParcela,
                        });
                    }
                    const resultParcelado = await individualCollection.insertMany(gastosParcelados);

                    detalhesItens.push({ tipo: 'gasto_parcelado', insertedIds: resultParcelado.insertedIds, gastos: gastosParcelados });
                    const totalParcelado = (installmentValue * installments).toFixed(2).replace('.', ',');
                    linhasResposta.push(`✅ *${description}* em ${installments}x de R$ ${installmentValue.toFixed(2).replace('.', ',')} (total R$ ${totalParcelado}, ${categoriaFinal}, ${owner})`);
                }
            }

            if (gastoToolUses.length === 1) {
                acao = detalhesItens[0].tipo;
                detalhes = detalhesItens[0];
                reply = linhasResposta[0];
            } else {
                acao = 'gastos_multiplos';
                detalhes = { itens: detalhesItens };
                reply = `✅ ${detalhesItens.length} gastos registrados:\n${linhasResposta.join('\n')}`;
            }

        } else if (consultaToolUse) {
            const toolUse = consultaToolUse;
            const periodo = toolUse.input.periodo || 'mes_atual';
            const { start, end } = intervaloDoPeriodo(periodo);

            const gastos = await individualCollection.find(
                filtroPorPeriodo(periodo, start, end)
            ).sort({ date: -1 }).toArray();

            const resumoPorCategoria = {};
            let total = 0;
            for (const g of gastos) {
                resumoPorCategoria[g.category] = (resumoPorCategoria[g.category] || 0) + g.value;
                total += g.value;
            }

            const segundaResposta = await anthropic.messages.create({
                model: CLAUDE_MODEL,
                max_tokens: 512,
                system: `Você é um assistente financeiro. Responda a pergunta do usuário de forma direta, curta (poucas frases) e em português, com base EXCLUSIVAMENTE nos dados abaixo. Se não houver dados suficientes, diga isso.
Dados do período "${periodo}" (${gastos.length} lançamentos, total R$ ${total.toFixed(2)}):
Resumo por categoria: ${JSON.stringify(resumoPorCategoria)}
Lançamentos individuais: ${JSON.stringify(gastos.map(g => ({ descricao: g.description, valor: g.value, categoria: g.category, dono: g.owner, data: g.date })))}`,
                messages: [{ role: 'user', content: message }],
            });

            reply = segundaResposta.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
            acao = 'consulta';
            detalhes = { periodo, total, resumoPorCategoria, quantidade: gastos.length };

        } else {
            reply = primeiraResposta.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                || "Não entendi bem — pode reformular? Você pode me contar um gasto (ex: \"Monster 12,99\") ou perguntar algo sobre seus gastos.";
        }

        await chatCollection.insertOne({ role: 'assistant', content: reply, action: acao, date: new Date() });

        res.json({ reply, action: acao, detalhes });
    } catch (error) {
        console.error("Erro no chat:", error);
        res.status(500).json({ error: "Erro ao processar mensagem no chat.", detalhe: error.message });
    }
});

app.get('/api/chat/history', async (req, res) => {
    if (!chatCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }
    const limit = parseInt(req.query.limit) || 50;
    try {
        const mensagens = await chatCollection.find({}).sort({ date: -1 }).limit(limit).toArray();
        res.json(mensagens.reverse());
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar histórico do chat." });
    }
});


// --- ROTA 4: Edição de Transação (PUT /api/transactions/:id) ---
app.put('/api/transactions/:id', async (req, res) => {
    if (!transactionsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    const { id } = req.params;
    const { description, value, date, type, category, isRecurrent } = req.body;

    if (!description || !value || !date || !type || !category) {
        return res.status(400).json({ error: "Todos os campos são obrigatórios." });
    }

    // Garante que o ID é um ObjectId válido
    let objectId;
    try {
        objectId = new ObjectId(id);
    } catch (e) {
        return res.status(400).json({ error: "ID de transação inválido." });
    }

    // Converte a data para UTC 
    const dateOnly = date.substring(0, 10);
    const utcDate = new Date(dateOnly + 'T00:00:00Z');

    const updatedFields = {
        description,
        value: parseFloat(value),
        date: utcDate,
        type: type.toUpperCase(),
        category,
        isRecurrent: !!isRecurrent,
    };

    // Objeto para armazenar operações de remoção de campo (unset)
    const unsetFields = {};

    try {
        // 1. Busca a transação antiga para obter o ID ROOT original, se houver
        const oldTransaction = await transactionsCollection.findOne({ _id: objectId });

        if (!oldTransaction) {
            return res.status(404).json({ error: "Transação não encontrada." });
        }

        // 2. Lógica para EDITAR E QUEBRAR A CADEIA DE RECORRÊNCIA
        if (updatedFields.isRecurrent) {

            // Determina qual é o ID ROOT original
            const rootId = oldTransaction.replicatedFromId;

            // Se esta for uma réplica (tem rootId), o modelo ROOT antigo deve ser DESATIVADO
            if (rootId) {
                // 2.1. Desativa o modelo ROOT original para que ele não gere mais réplicas
                await transactionsCollection.updateOne(
                    { _id: rootId },
                    { $set: { isSuperseded: true } }
                );
                console.log(`[Recorrência - Edição] Modelo ROOT antigo ${rootId} desativado (isSuperseded: true).`);

                // 2.2. Deleta TODAS as réplicas futuras (do próximo mês em diante)
                const deleteResult = await transactionsCollection.deleteMany({
                    replicatedFromId: rootId,
                    date: { $gt: utcDate } // Deleta estritamente futuras
                });
                console.log(`[Recorrência - Edição] Deletadas ${deleteResult.deletedCount} réplicas futuras que apontavam para o ROOT antigo.`);

                // 2.3. Transação editada se torna o NOVO ROOT.
                // 💡 CORREÇÃO AQUI: Remove o campo replicatedFromId do documento no banco.
                unsetFields.replicatedFromId = ""; // Usa $unset para remover explicitamente o campo
                delete updatedFields.replicatedFromId; // Remove da operação $set
            } else if (oldTransaction.isRecurrent) {
                // O usuário está editando o ROOT original diretamente.
                // Deletamos apenas as réplicas futuras (do próximo mês em diante)
                const nextMonth = new Date(utcDate.getFullYear(), utcDate.getMonth() + 1, 1);

                const deleteResult = await transactionsCollection.deleteMany({
                    replicatedFromId: oldTransaction._id,
                    date: { $gte: nextMonth }
                });
                console.log(`[Recorrência - Edição] Deletadas ${deleteResult.deletedCount} réplicas futuras do ROOT original.`);
            }

        } else {
            // Se isRecurrent se tornou FALSE, o item é tratado como transação única.
            if (oldTransaction.isRecurrent) {
                const rootId = oldTransaction.replicatedFromId || oldTransaction._id;
                // Deletamos todas as réplicas futuras.
                await transactionsCollection.deleteMany({
                    replicatedFromId: rootId,
                    date: { $gte: utcDate }
                });
                // Removemos o status de ROOT do item editado, se aplicável
                unsetFields.replicatedFromId = "";
                unsetFields.isSuperseded = "";
                delete updatedFields.replicatedFromId;
                delete updatedFields.isSuperseded;
            }
        }

        // 3. Executa a atualização do documento (incluindo as operações $set e $unset)
        const updateOperations = { $set: updatedFields };
        if (Object.keys(unsetFields).length > 0) {
            updateOperations.$unset = unsetFields;
        }

        const result = await transactionsCollection.updateOne(
            { _id: objectId },
            updateOperations
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Transação não encontrada após a busca inicial." });
        }

        res.json({
            message: "Transação atualizada com sucesso. A cadeia de recorrência foi ajustada a partir desta data.",
            modifiedCount: result.modifiedCount
        });

    } catch (error) {
        console.error("Erro ao atualizar transação:", error);
        res.status(500).json({ error: "Erro interno do servidor ao atualizar a transação." });
    }
});


// --- ROTA 5: Exclusão de Transação (DELETE /api/transactions/:id) ---
app.delete('/api/transactions/:id', async (req, res) => {
    if (!transactionsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    const { id } = req.params;

    // Garante que o ID é um ObjectId válido
    let objectId;
    try {
        objectId = new ObjectId(id);
    } catch (e) {
        return res.status(400).json({ error: "ID de transação inválido." });
    }

    try {
        // 1. Busca a transação antes de deletar
        const transaction = await transactionsCollection.findOne({ _id: objectId });

        if (!transaction) {
            return res.status(404).json({ error: "Transação não encontrada." });
        }

        // 2. Lógica para DELETAR E QUEBRAR A CADEIA DE RECORRÊNCIA
        let deletedFutureCount = 0;

        if (transaction.isRecurrent) {
            const rootId = transaction.replicatedFromId || transaction._id;

            // Deleta todas as réplicas futuras (do mês seguinte ao mês deletado em diante)
            const nextMonth = new Date(transaction.date.getFullYear(), transaction.date.getMonth() + 1, 1);

            const deleteFutureResult = await transactionsCollection.deleteMany({
                $or: [
                    { replicatedFromId: rootId, date: { $gte: nextMonth } },
                    { _id: rootId, date: { $gte: nextMonth } } // Cobre o caso do ROOT ser deletado
                ]
            });
            deletedFutureCount = deleteFutureResult.deletedCount;

            console.log(`[Recorrência - Exclusão] Deletadas ${deletedFutureCount} réplicas futuras para o ROOT: ${rootId}`);

            // 💡 NOVO: Se o item deletado for uma réplica, o ROOT original deve ser reativado
            if (transaction.replicatedFromId) {
                await transactionsCollection.updateOne(
                    { _id: transaction.replicatedFromId },
                    { $unset: { isSuperseded: "" } } // Remove a flag
                );
            }
        }

        // 3. Deleta a transação atual
        const result = await transactionsCollection.deleteOne({ _id: objectId });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Transação não encontrada durante a exclusão." });
        }

        res.json({
            message: "Transação excluída com sucesso.",
            deletedCount: result.deletedCount,
            deletedFutureCount: deletedFutureCount
        });

    } catch (error) {
        console.error("Erro ao excluir transação:", error);
        res.status(500).json({ error: "Erro interno do servidor ao excluir a transação." });
    }
});


// --- ROTA 6: Extrato Mensal Detalhado (GET /api/transactions/monthly-list) ---
app.get('/api/transactions/monthly-list', async (req, res) => {
    // ... (código resumido, não alterado) ...
    if (!transactionsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    const { year, month } = req.query;
    if (!year || !month) {
        return res.status(400).json({ error: "Parâmetros 'year' e 'month' (numéricos) são obrigatórios." });
    }

    const y = parseInt(year);
    const m = parseInt(month);

    // Opcional: Checa e cria transações recorrentes (agora sincronizado)
    await replicateRecurringTransactions(y, m);

    // 🌟 CORREÇÃO DE DATA: Filtro do Extrato (monthly-list)
    const startDate = new Date(Date.UTC(y, m - 1, 1));
    const endDate = new Date(Date.UTC(y, m, 1));

    try {
        const transactions = await transactionsCollection.find({
            date: { $gte: startDate, $lt: endDate }, // Filtro exato para o mês
        })
            .sort({ date: 1 })
            .toArray();

        res.json({
            month: m,
            year: y,
            transactions: transactions,
        });

    } catch (error) {
        console.error("Erro ao buscar a lista de transações:", error);
        res.status(500).json({ error: "Erro interno do servidor ao buscar extrato." });
    }
});


// --- ROTA 7: LIMPAR TODO O BANCO DE DADOS (DELETE /api/data/clean) ---
app.delete('/api/data/clean', async (req, res) => {
    if (!transactionsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    if (req.query.confirm !== 'I_AM_SURE') {
        return res.status(400).json({
            error: "Confirmação necessária. Use o parâmetro ?confirm=I_AM_SURE na URL para limpar o banco."
        });
    }

    try {
        const result = await transactionsCollection.deleteMany({});
        res.json({
            message: "Banco de dados limpo com sucesso.",
            deletedCount: result.deletedCount,
        });

    } catch (error) {
        console.error("Erro ao limpar o banco de dados:", error);
        res.status(500).json({ error: "Erro interno do servidor ao limpar o DB." });
    }
});