// server.mjs
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb'; // Adicionado ObjectId
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';

// --- CONFIGURAÇÕES BÁSICAS ---
const app = express();
const PORT = process.env.PORT || 3000;
const DB_NAME = "planejamento_financeiro";
const COLLECTION_NAME = "transactions";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let individualCollection;
let disneyCollection;
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
        await individualCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            {
                $set: {
                    description,
                    value: parseFloat(value),
                    owner,
                    date: new Date(date),
                    category
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
        await individualCollection.insertOne({
            description,
            value: parseFloat(value),
            owner,
            date: new Date(date), // O Mongo salvará a data exata escolhida
            category
        });
        res.status(201).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Erro ao salvar" });
    }
});

app.get('/api/individual/list', async (req, res) => {
    const { month, year } = req.query;
    const startDate = new Date(Date.UTC(year, month, 1));
    const endDate = new Date(Date.UTC(year, parseInt(month) + 1, 1));

    try {
        const expenses = await individualCollection.find({
            date: { $gte: startDate, $lt: endDate }
        }).sort({ date: -1 }).toArray();
        res.json(expenses);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar" });
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