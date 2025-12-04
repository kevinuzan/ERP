// app.js

// --- CONFIGURAÇÕES BÁSICAS ---
const API_BASE_URL = '/api';
const TRANSACTION_API_URL = `${API_BASE_URL}/transactions`;
const SUMMARY_API_URL = `${API_BASE_URL}/summary`;
const MONTHLY_LIST_API_URL = `${API_BASE_URL}/transactions/monthly-list`;
const BREAKDOWN_API_URL = `${API_BASE_URL}/breakdown`; // Nova Rota para o Gráfico
const CLEAN_API_URL = `${API_BASE_URL}/data/clean?confirm=I_AM_SURE`;

let currentDisplayDate = new Date();
let expenseChart = null; // Instância global para o gráfico Chart.js

// --- FUNÇÕES DE UTILIDADE E UI ---

/**
 * Substitui alert() e confirm() por notificação simples (Requisito do ambiente).
 */
function showNotification(message, isError = false) {
    const notificationContainer = document.getElementById('notification-container');
    const notification = document.createElement('div');
    
    // Classes Tailwind para notificação
    const baseClasses = "p-3 mb-3 rounded-lg shadow-md font-semibold text-sm transition-all duration-300 transform translate-y-0";
    const errorClasses = "bg-red-100 text-red-700 border border-red-400";
    const successClasses = "bg-green-100 text-green-700 border border-green-400";

    notification.className = isError ? `${baseClasses} ${errorClasses}` : `${baseClasses} ${successClasses}`;
    notification.textContent = message;

    notificationContainer.appendChild(notification);

    // Remove a notificação após 5 segundos
    setTimeout(() => {
        notification.classList.add('opacity-0');
        notification.addEventListener('transitionend', () => notification.remove());
    }, 5000);
}

/**
 * Cria a paleta de cores para o gráfico.
 */
function generateColors(count) {
    const colors = [
        '#EF4444', '#F97316', '#FBBF24', '#22C55E', '#3B82F6', 
        '#6366F1', '#A855F7', '#EC4899', '#84DED3', '#78716C'
    ];
    let palette = [];
    for(let i = 0; i < count; i++) {
        palette.push(colors[i % colors.length]);
    }
    return palette;
}

/**
 * Formata um número para moeda brasileira (R$).
 */
function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

/**
 * Converte data do MongoDB (ISO 8601) para AAAA-MM-DD
 */
function formatDateForInput(dateString) {
    const date = new Date(dateString);
    // Formata para 'AAAA-MM-DD' em UTC para garantir que o input[type=date] exiba corretamente.
    return date.toISOString().substring(0, 10);
}

/**
 * Renderiza o gráfico de pizza de despesas.
 * @param {Array} breakdownData - Detalhamento das despesas por categoria.
 */
function renderPieChart(breakdownData) {
    const chartContainer = document.getElementById('chartContainer');
    chartContainer.innerHTML = '<canvas id="expenseChartCanvas"></canvas>';
    const ctx = document.getElementById('expenseChartCanvas').getContext('2d');

    if (expenseChart) {
        expenseChart.destroy();
    }

    if (breakdownData.length === 0) {
        chartContainer.innerHTML = '<p class="text-center text-gray-500 py-4">Nenhuma despesa para exibir no gráfico neste mês.</p>';
        return;
    }
    
    const backgroundColors = generateColors(breakdownData.length);

    expenseChart = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: breakdownData.map(item => item.category),
            datasets: [{
                data: breakdownData.map(item => item.total),
                backgroundColor: backgroundColors,
                hoverOffset: 10,
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.label || '';
                            if (context.parsed !== null) {
                                label += ': ' + formatCurrency(context.parsed);
                            }
                            return label;
                        }
                    }
                }
            }
        }
    });
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

/**
 * Renderiza os cards de resumo e a tabela de detalhamento.
 */
function renderSummary(summaryData, saldo) {
    const incomeData = summaryData.find(item => item.type === 'RECEITA');
    const expenseData = summaryData.find(item => item.type === 'DESPESA');

    const totalIncome = incomeData ? incomeData.total : 0;
    const totalExpense = expenseData ? expenseData.total : 0;
    
    const container = document.getElementById('summary-container');
    container.innerHTML = `
        <div class="summary-card bg-green-100 text-green-800 border-green-300">
            <h3 class="text-sm font-medium">Entradas (Receita)</h3>
            <p class="text-xl font-bold">${formatCurrency(totalIncome)}</p>
        </div>
        <div class="summary-card bg-red-100 text-red-800 border-red-300">
            <h3 class="text-sm font-medium">Gastos (Despesa)</h3>
            <p class="text-xl font-bold">${formatCurrency(totalExpense)}</p>
        </div>
        <div class="summary-card bg-blue-100 text-gray-800 border-blue-300">
            <h3 class="text-sm font-medium">Sobra / Déficit</h3>
            <p class="text-xl font-bold ${saldo >= 0 ? 'text-green-600' : 'text-red-600'}">${formatCurrency(saldo)}</p>
        </div>
    `;

    // Renderiza a Tabela de Detalhes de Despesas (abaixo do gráfico, se houver)
    const tbody = document.querySelector('#expense-breakdown-table tbody');
    tbody.innerHTML = '';
    const breakdownList = expenseData ? expenseData.breakdown : [];

    if (breakdownList.length > 0) {
        breakdownList.forEach(item => {
            const row = tbody.insertRow();
            row.insertCell(0).textContent = item.category;
            row.insertCell(1).textContent = formatCurrency(item.total);
            row.cells[1].classList.add('text-right');
        });
    } else {
        tbody.innerHTML = '<tr><td colspan="2" class="text-center text-gray-500">Nenhum gasto registrado no mês.</td></tr>';
    }
}

/**
 * Renderiza a lista detalhada de transações.
 */
function renderTransactionList(transactions) {
    const tbody = document.querySelector('#transaction-list-table tbody');
    tbody.innerHTML = '';

    if (transactions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-4">Nenhuma transação encontrada para este mês.</td></tr>'; // 7 colunas
        return;
    }

    transactions.forEach(t => {
        const row = tbody.insertRow();
        const date = new Date(t.date);
        const formattedDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(date);
        
        const isReceita = t.type === 'RECEITA';
        const valueClass = isReceita ? 'text-green-600' : 'text-red-600';
        const recurrentIcon = t.isRecurrent ? '⚡' : '';

        row.insertCell(0).textContent = formattedDate;
        row.insertCell(1).textContent = t.description;
        row.insertCell(2).textContent = t.category;
        row.insertCell(3).textContent = t.type;

        const valueCell = row.insertCell(4);
        valueCell.textContent = formatCurrency(t.value);
        valueCell.classList.add('text-right', 'font-bold', valueClass);
        
        row.insertCell(5).textContent = recurrentIcon; // Campo Rec.
        
        // 💡 NOVA COLUNA: Ações
        const actionsCell = row.insertCell(6);
        actionsCell.classList.add('text-center');
        
        // Botão Editar
        const editBtn = document.createElement('button');
        editBtn.className = 'text-blue-600 hover:text-blue-800 font-semibold mr-3';
        editBtn.textContent = 'Editar';
        editBtn.onclick = () => openEditModal(t);

        // Botão Excluir (Oculto, pois a exclusão será feita pelo modal)
        
        actionsCell.appendChild(editBtn);
        // O botão de exclusão será incluído diretamente no modal para ter a confirmação antes.
    });
}


// --- FUNÇÕES DE EDIÇÃO E EXCLUSÃO (MODAL) ---

/**
 * Abre o modal de edição e preenche os campos com os dados da transação.
 */
function openEditModal(transaction) {
    const modal = document.getElementById('editModal');
    
    // Preenche os campos do formulário
    document.getElementById('edit-id').value = transaction._id;
    document.getElementById('edit-description').value = transaction.description;
    document.getElementById('edit-value').value = transaction.value;
    document.getElementById('edit-type').value = transaction.type;
    document.getElementById('edit-category').value = transaction.category;
    document.getElementById('edit-isRecurrent').checked = transaction.isRecurrent;
    
    // A data do MongoDB é ISO string. Precisa ser convertida para AAAA-MM-DD
    document.getElementById('edit-date').value = formatDateForInput(transaction.date);

    // Configura o botão de exclusão
    document.getElementById('delete-btn').onclick = () => handleDelete(transaction._id, transaction.description);

    // Exibe o modal
    modal.classList.remove('hidden');
}

/**
 * Fecha o modal de edição.
 */
function closeEditModal() {
    document.getElementById('editModal').classList.add('hidden');
    document.getElementById('editForm').reset();
}

/**
 * Submete a edição para a rota PUT.
 */
async function submitEdit(event) {
    event.preventDefault();
    const form = event.target;
    const id = form.id.value;

    const data = {
        description: form.description.value,
        value: form.value.value,
        date: form.date.value,
        type: form.type.value,
        category: form.category.value,
        isRecurrent: form.isRecurrent.checked,
    };

    try {
        const response = await fetch(`${TRANSACTION_API_URL}/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            showNotification(`✅ Edição Salva. ${result.message}`);
            closeEditModal();
            loadCurrentMonthData(); // Recarrega os dados
        } else {
            showNotification(`❌ Erro ao salvar edição: ${result.error || 'Falha desconhecida.'}`, true);
        }
    } catch (error) {
        console.error('Erro ao enviar edição:', error);
        showNotification('❌ Erro de conexão ao servidor ao editar.', true);
    }
}

/**
 * Lógica para exclusão de transação.
 */
async function handleDelete(id, description) {
    const confirmation = prompt(`⚠️ Para EXCLUIR permanentemente a transação "${description}", digite 'EXCLUIR' abaixo:`);
    
    if (confirmation !== 'EXCLUIR') {
        showNotification("A exclusão foi cancelada.", true);
        return;
    }

    try {
        const response = await fetch(`${TRANSACTION_API_URL}/${id}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (response.ok) {
            closeEditModal();
            showNotification(`✅ Transação excluída. ${result.deletedFutureCount} réplicas futuras foram removidas.`);
            loadCurrentMonthData(); // Recarrega os dados
        } else {
            showNotification(`❌ Erro ao excluir: ${result.error || 'Falha desconhecida.'}`, true);
        }
    } catch (error) {
        console.error('Erro ao enviar exclusão:', error);
        showNotification('❌ Erro de conexão ao servidor ao excluir.', true);
    }
}


// --- FUNÇÕES DE FETCH (Requisições à API) ---

/**
 * Busca e renderiza o detalhamento de despesas para o gráfico.
 */
async function fetchAndRenderBreakdownChart(year, month) {
    const url = `${BREAKDOWN_API_URL}?year=${year}&month=${month}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Erro HTTP: ${response.status}`);
        }
        const breakdownData = await response.json();
        renderPieChart(breakdownData);
    } catch (error) {
        console.error('Erro ao carregar o gráfico de detalhamento:', error);
        document.getElementById('chartContainer').innerHTML = 
            '<p class="text-center text-red-500 py-4">Erro ao carregar o gráfico.</p>';
    }
}


/**
 * Busca e renderiza o resumo mensal (Totais e Saldo).
 */
async function fetchMonthlySummary(year, month) {
    const url = `${SUMMARY_API_URL}?year=${year}&month=${month}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Erro HTTP: ${response.status}`);
        }
        const data = await response.json();
        renderSummary(data.data, data.saldo);
    } catch (error) {
        console.error('Erro ao carregar o resumo mensal:', error);
        document.getElementById('summary-container').innerHTML =
            '<p class="text-red-500 p-4">Não foi possível conectar à API ou carregar dados.</p>';
    }
}

/**
 * Busca e renderiza a lista detalhada de transações.
 */
async function fetchAndRenderTransactionList(year, month) {
    const url = `${MONTHLY_LIST_API_URL}?year=${year}&month=${month}`;
    const tbody = document.querySelector('#transaction-list-table tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-4">Carregando extrato...</td></tr>'; // 7 colunas

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Erro HTTP: ${response.status}`);
        }
        const data = await response.json();
        renderTransactionList(data.transactions);
    } catch (error) {
        console.error('Erro ao carregar lista de transações:', error);
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-red-500 py-4">Erro ao buscar dados: ${error.message}</td></tr>`;
    }
}

/**
 * Manipula a submissão do formulário.
 */
function handleFormSubmit(event) {
    event.preventDefault();

    const form = event.target;
    
    const formData = {
        description: form.description.value,
        value: parseFloat(form.value.value),
        date: form.date.value,
        type: form.type.value,
        category: form.category.value,
        isRecurrent: form.isRecurrent.checked,
    };

    submitTransaction(formData, form);
}

async function submitTransaction(data, form) {
    try {
        const response = await fetch(TRANSACTION_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        const result = await response.json();

        if (response.ok) {
            showNotification(`✅ Transação Salva: ${data.description}`);
            form.reset();

            // Atualiza a visualização para o mês da transação inserida
            currentDisplayDate = new Date(data.date);
            currentDisplayDate.setDate(1); // Garante que é o primeiro dia
            loadCurrentMonthData();
        } else {
            showNotification(`❌ Falha ao Salvar: ${result.error || 'Erro desconhecido.'}`, true);
        }
    } catch (error) {
        showNotification('❌ Erro de conexão ao servidor ao salvar.', true);
        console.error('Erro de submissão:', error);
    }
}

/**
 * Lógica para limpar o banco de dados (substituindo o 'confirm' nativo).
 */
async function cleanDatabase() {
    const userWantsToProceed = prompt("⚠️ Para DELETAR PERMANENTEMENTE TODAS as suas transações, digite 'DELETAR' abaixo:");
    
    if (userWantsToProceed !== 'DELETAR') {
        showNotification("A limpeza do banco foi cancelada.", true);
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
            showNotification(`✅ Sucesso: ${result.message} (${result.deletedCount} documentos deletados).`);
            // Recarrega o painel para mostrar a tela limpa
            loadCurrentMonthData();
        } else {
            throw new Error(result.error || 'Erro desconhecido ao limpar.');
        }

    } catch (error) {
        showNotification(`❌ Falha na Limpeza do DB: ${error.message}`, true);
        console.error('Erro de limpeza:', error);
    } finally {
        button.textContent = '⚠️ Limpar TODO o Banco de Dados';
        button.disabled = false;
    }
}


// --- LÓGICA DE NAVEGAÇÃO E CARREGAMENTO GERAL ---

/**
 * Carrega e renderiza o resumo e a lista de transações para o mês/ano atual.
 */
function loadCurrentMonthData() {
    const year = currentDisplayDate.getFullYear();
    const month = currentDisplayDate.getMonth() + 1; // getMonth é zero-based
    
    // 1. Atualiza o display
    updateMonthDisplay(year, month);

    // 2. Carrega os dados de Resumo e Saldo (inclui replicação no server.mjs)
    fetchMonthlySummary(year, month);
    
    // 3. Carrega o Extrato Detalhado
    fetchAndRenderTransactionList(year, month);

    // 4. Carrega os dados para o Gráfico de Pizza
    fetchAndRenderBreakdownChart(year, month);
}

/**
 * Altera o mês atual de exibição e recarrega os dados.
 */
function changeMonth(delta) {
    currentDisplayDate.setMonth(currentDisplayDate.getMonth() + delta);
    loadCurrentMonthData();
}

function toggleFormVisibility() {
    const content = document.getElementById('transaction-form-content');
    const icon = document.getElementById('toggle-icon');
    
    // Alterna a classe 'hidden' para esconder/mostrar (Melhor que style.display)
    content.classList.toggle('hidden'); 
    
    if (content.classList.contains('hidden')) {
        icon.textContent = '▼'; // Ícone para 'Abrir'
    } else {
        icon.textContent = '▲'; // Ícone para 'Fechar'
    }
}


// --- INICIALIZAÇÃO ---
document.addEventListener('DOMContentLoaded', () => {
    // Garante que a data de exibição começa no dia 1
    currentDisplayDate.setDate(1);

    // Configura listeners para navegação
    document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
    document.getElementById('next-month').addEventListener('click', () => changeMonth(1));

    // Configura o listener para o formulário de nova transação
    document.getElementById('transaction-form').addEventListener('submit', handleFormSubmit);

    // Configura listener para o botão de limpeza
    // document.getElementById('reset-data-btn').addEventListener('click', cleanDatabase);
    
    // Listener para o Toggle do Formulário
    document.getElementById('form-toggle-header').addEventListener('click', toggleFormVisibility);
    
    // Listener para o modal de edição
    document.getElementById('editForm').addEventListener('submit', submitEdit);
    document.getElementById('close-modal-btn').addEventListener('click', closeEditModal);

    // Preenche a data inicial do formulário
    const today = new Date();
    document.getElementById('transaction-date').value = 
        `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Carrega os dados
    loadCurrentMonthData();
});