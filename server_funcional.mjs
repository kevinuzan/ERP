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

// --- CONEXÃO PERSISTENTE COM O MONGODB ---
let transactionsCollection;

async function connectDB() {
    try {
        const client = new MongoClient(MONGO_URI);
        console.log(`URI de Conexão: ${MONGO_URI.substring(0, 30)}...`); // Log da URI truncada
        await client.connect();
        const db = client.db(DB_NAME);
        transactionsCollection = db.collection(COLLECTION_NAME);
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
            const recurringModels = await transactionsCollection.find({
                date: { $lt: targetStartDate }, // Transações anteriores ao mês alvo
                isRecurrent: true,
                replicatedFromId: { $exists: false } // APENAS modelos originais (ROOT)
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
// Calcula o total de receitas e despesas por categoria para um dado mês/ano.
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


// --- ROTA 2: Detalhamento por Categoria (GET /api/breakdown) ---
// Retorna a lista de despesas por categoria, ideal para o gráfico de pizza.
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
            { $match: { 
                date: { $gte: startDate, $lt: endDate },
                type: 'DESPESA', // Filtra apenas despesas para o gráfico
            }},
            { $group: {
                _id: "$category",
                total: { $sum: "$value" },
            }},
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

// --- ROTA 4: Extrato Mensal Detalhado (GET /api/transactions/monthly-list) ---
app.get('/api/transactions/monthly-list', async (req, res) => {
    if (!transactionsCollection) {
        return res.status(503).json({ error: "Servidor indisponível: Conexão DB falhou." });
    }

    const { year, month } = req.query;
    if (!year || !month) {
        return res.status(400).json({ error: "Parâmetros 'year' e 'month' são obrigatórios." });
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


// --- ROTA 5: LIMPAR TODO O BANCO DE DADOS (DELETE /api/data/clean) ---
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