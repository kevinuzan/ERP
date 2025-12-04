// app.js

// --- CONFIGURAÇÕES DA API E DATAS ---
const API_BASE_URL = 'http://localhost:3000/api';
const TRANSACTION_API_URL = `${API_BASE_URL}/transactions`;
const SUMMARY_API_URL = `${API_BASE_URL}/summary`;
const MONTHLY_LIST_API_URL = `${API_BASE_URL}/transactions/monthly-list`;
const CLEAN_API_URL = `${API_BASE_URL}/data/clean?confirm=I_AM_SURE`;

// Estado global para rastrear o mês/ano atualmente exibido
let currentDisplayDate = new Date();
// Define a data inicial para o mês atual, se não houver dados, ajuste manualmente para o seu mês de teste (Ex: new Date(2025, 11, 1) para Dezembro de 2025)

async function cleanDatabase() {
    // 1. Confirmação de Segurança
    const confirmation = confirm("TEM CERTEZA? Esta ação irá DELETAR PERMANENTEMENTE TODAS as suas transações do MongoDB!");

    if (!confirmation) {
        alert("A limpeza do banco foi cancelada.");
        return;
    }

    const button = document.getElementById('reset-data-btn');
    button.textContent = 'Limpando...';
    button.disabled = true;

    try {
        const response = await fetch(CLEAN_API_URL, {
            method: 'DELETE',
        });

        const result = await response.json();

        if (response.ok) {
            alert(`✅ Sucesso: ${result.message} (${result.deletedCount} documentos deletados).`);

            // Recarrega o painel para mostrar a tela limpa
            loadCurrentMonthData();
        } else {
            throw new Error(result.error || 'Erro desconhecido ao limpar.');
        }

    } catch (error) {
        alert(`❌ Falha na Limpeza do DB: ${error.message}`);
        console.error('Erro de limpeza:', error);
    } finally {
        button.textContent = '⚠️ Limpar TODO o Banco de Dados';
        button.disabled = false;
    }
}

// --- INICIALIZAÇÃO E LISTENERS ---
document.addEventListener('DOMContentLoaded', () => {
    // Define a data inicial (ex: 1º dia do mês)
    currentDisplayDate.setDate(1);

    // Carrega a data inicial e os dados
    loadCurrentMonthData();

    // Configura listeners para navegação
    document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
    document.getElementById('next-month').addEventListener('click', () => changeMonth(1));

    // Configura o listener para o formulário de nova transação
    const form = document.getElementById('transaction-form');
    form.addEventListener('submit', handleFormSubmit);

    // Define a data do formulário para o dia atual por conveniência
    const today = new Date();
    form.date.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    // 4. Configura listener para o botão de limpeza
    document.getElementById('reset-data-btn').addEventListener('click', cleanDatabase);
    // --- NOVO: Listener para o Toggle do Formulário ---
    document.getElementById('form-toggle-header').addEventListener('click', toggleFormVisibility);
});

/**
 * Altera o mês atual de exibição e recarrega os dados.
 * @param {number} delta - -1 para mês anterior, 1 para próximo mês.
 */
function changeMonth(delta) {
    currentDisplayDate.setMonth(currentDisplayDate.getMonth() + delta);
    loadCurrentMonthData();
}

/**
 * Carrega e renderiza o resumo e a lista de transações para o mês/ano atual.
 */
function loadCurrentMonthData() {
    const year = currentDisplayDate.getFullYear();
    const month = currentDisplayDate.getMonth() + 1; // getMonth é zero-based
    console.log(year, month)
    // 1. Atualiza o display
    updateMonthDisplay(year, month);

    // 2. Carrega os dados
    fetchMonthlySummary(year, month);
    // console.log(fetchMonthlySummary(year, month))
    fetchAndRenderTransactionList(year, month);
}

/**
 * Atualiza o texto do filtro com o mês e ano atuais.
 */
function updateMonthDisplay(year, month) {
    const monthNames = [
        "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
        "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
    ];
    document.getElementById('current-month-display').textContent =
        `${monthNames[month - 1]} / ${year}`;
}


// --- FUNÇÃO 1: BUSCAR E RENDERIZAR RESUMO (Cards) ---

async function fetchMonthlySummary(year, month) {
    const url = `${SUMMARY_API_URL}?year=${year}&month=${month}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Erro HTTP: ${response.status}`);
        }
        const data = await response.json();
        renderSummary(data.data);
    } catch (error) {
        console.error('Erro ao carregar o resumo mensal:', error);
        document.getElementById('summary-container').innerHTML =
            '<p style="color: red;">Não foi possível conectar à API ou carregar dados.</p>';
    }
}

function renderSummary(summaryData) {
    const incomeData = summaryData.find(item => item.type === 'RECEITA');
    const expenseData = summaryData.find(item => item.type === 'DESPESA');

    const totalIncome = incomeData ? incomeData.total : 0;
    const totalExpense = expenseData ? expenseData.total : 0;
    const balance = totalIncome - totalExpense;

    // Renderiza os Cards de Resumo
    const container = document.getElementById('summary-container');
    container.innerHTML = `
        ${createSummaryCard('Entradas (Receita)', totalIncome, 'card-income')}
        ${createSummaryCard('Gastos (Despesa)', totalExpense, 'card-expense')}
        ${createBalanceCard('Sobra / Déficit', balance, 'card-balance')}
    `;

    // Renderiza a Tabela de Detalhes de Despesas
    const tbody = document.querySelector('#expense-breakdown-table tbody');
    tbody.innerHTML = '';

    if (expenseData && expenseData.breakdown.length > 0) {
        expenseData.breakdown.forEach(item => {
            const row = tbody.insertRow();
            row.insertCell(0).textContent = item.category;
            row.insertCell(1).textContent = formatCurrency(item.total);
            row.cells[1].style.textAlign = 'right';
        });
    } else {
        tbody.innerHTML = '<tr><td colspan="2">Nenhum gasto registrado no mês.</td></tr>';
    }
}


// --- FUNÇÃO 2: BUSCAR E RENDERIZAR LISTA DETALHADA (Dia a Dia) ---

async function fetchAndRenderTransactionList(year, month) {
    const url = `${MONTHLY_LIST_API_URL}?year=${year}&month=${month}`;
    const tbody = document.querySelector('#transaction-list-table tbody');
    tbody.innerHTML = '<tr><td colspan="5">Carregando extrato...</td></tr>';

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Erro HTTP: ${response.status}`);
        }
        const data = await response.json();

        tbody.innerHTML = '';

        if (data.transactions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5">Nenhuma transação encontrada para este mês.</td></tr>';
            return;
        }

        data.transactions.forEach(t => {
            const row = tbody.insertRow();

            const date = new Date(t.date);
            const formattedDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(date);
            const valueClass = t.type === 'RECEITA' ? 'positive' : 'negative';

            row.insertCell(0).textContent = formattedDate;
            row.insertCell(1).textContent = t.description;
            row.insertCell(2).textContent = t.category;
            row.insertCell(3).textContent = t.type;

            const valueCell = row.insertCell(4);
            valueCell.textContent = formatCurrency(t.value);
            valueCell.classList.add(valueClass);
            valueCell.style.textAlign = 'right';
        });

    } catch (error) {
        console.error('Erro ao carregar lista de transações:', error);
        tbody.innerHTML = `<tr><td colspan="5" style="color: red;">Erro ao buscar dados: ${error.message}</td></tr>`;
    }
}


// --- FUNÇÕES 3: SUBMISSÃO DE FORMULÁRIO (POST) ---

function handleFormSubmit(event) {
    event.preventDefault();

    const form = event.target;
    const feedback = document.getElementById('message-feedback');

    // Captura os dados do formulário
    const formData = {
        description: form.description.value,
        value: parseFloat(form.value.value),
        date: form.date.value,
        type: form.type.value,
        category: form.category.value,

        // 🌟 CORREÇÃO: Lê a propriedade 'checked' do elemento input
        isRecurrent: form.isRecurrent.checked,
    };

    submitTransaction(formData, feedback, form);
}

async function submitTransaction(data, feedbackElement, form) {
    feedbackElement.textContent = 'Enviando...';
    feedbackElement.style.color = 'gray';

    try {
        const response = await fetch(TRANSACTION_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });

        const result = await response.json();

        if (response.ok) {
            feedbackElement.textContent = `✅ Transação Salva!`;
            feedbackElement.style.color = 'green';
            form.reset();

            // Após a inserção, recarrega o mês atual
            loadCurrentMonthData();
        } else {
            throw new Error(result.error || 'Erro desconhecido ao salvar.');
        }
    } catch (error) {
        feedbackElement.textContent = `❌ Falha ao Salvar: ${error.message}`;
        feedbackElement.style.color = 'red';
        console.error('Erro de submissão:', error);
    }
}


// --- FUNÇÕES AUXILIARES ---

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function createSummaryCard(title, value, className) {
    return `
        <div class="summary-card ${className}">
            <h3>${title}</h3>
            <p class="${value >= 0 ? 'positive' : 'negative'}">${formatCurrency(value)}</p>
        </div>
    `;
}

function createBalanceCard(title, value, className) {
    const balanceClass = value >= 0 ? 'positive' : 'negative';
    return `
        <div class="summary-card ${className}">
            <h3>${title}</h3>
            <p class="${balanceClass}">${formatCurrency(value)}</p>
        </div>
    `;
}

function toggleFormVisibility() {
    const content = document.getElementById('transaction-form-content');
    const icon = document.getElementById('toggle-icon');
    
    if (content.style.display === 'none' || content.style.display === '') {
        // Expandir (Mostrar)
        content.style.display = 'grid'; // Usamos grid, então colocamos grid
        icon.textContent = '−'; // Ícone para 'Fechar'
    } else {
        // Minimizar (Esconder)
        content.style.display = 'none';
        icon.textContent = '+'; // Ícone para 'Abrir'
    }
}