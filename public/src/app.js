// app.js

// --- CONFIGURAÇÕES BÁSICAS ---
const API_BASE_URL = '/api';
const TRANSACTION_API_URL = `${API_BASE_URL}/transactions`;
const SUMMARY_API_URL = `${API_BASE_URL}/summary`;
const MONTHLY_LIST_API_URL = `${API_BASE_URL}/transactions/monthly-list`;
const BREAKDOWN_API_URL = `${API_BASE_URL}/breakdown`; // Nova Rota para o Gráfico
const CLEAN_API_URL = `${API_BASE_URL}/data/clean?confirm=I_AM_SURE`;
const COTACAO_FIXA = 5.45;
const DISNEY_API_URL = `${API_BASE_URL}/disney`;
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
    for (let i = 0; i < count; i++) {
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
                        label: function (context) {
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


// 1. ADICIONE ESTA FUNÇÃO NO TOPO DO APP.JS
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// 2. AGORA A FUNÇÃO INITPUSH (COMO DISCUTIMOS)
async function initPush() {
    try {
        if (!('serviceWorker' in navigator)) return;

        // 1. PEDIR PERMISSÃO EXPLICITAMENTE
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            console.error("Permissão de notificação negada pelo usuário.");
            return;
        }

        const registration = await navigator.serviceWorker.ready;

        // 2. LIMPEZA (Opcional mas recomendado)
        const currentSub = await registration.pushManager.getSubscription();
        if (currentSub) await currentSub.unsubscribe();

        // 3. REGISTRO (Use sua chave VAPID pública aqui)
        const publicKey = 'BKU-RnXVzU2Ugxo7vk_Wh9dxY1fFE8A1M4cQEIMeDlY3dITozNxQrcA1uiuYvMSKxo4quovM-pD4sn5IIhpV71w'.trim();
        const convertedKey = urlBase64ToUint8Array(publicKey);

        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: convertedKey
        });

        console.log("✅ Assinatura obtida!");

        await fetch('/api/subscribe', {
            method: 'POST',
            body: JSON.stringify(subscription),
            headers: { 'Content-Type': 'application/json' }
        });

        console.log("✅ Agora sim! Navegador inscrito.");
    } catch (err) {
        console.error("❌ Erro fatal no Push:", err);
    }
}
// async function initPush() {
//     try {
//         console.log("A")
//         if (!('serviceWorker' in navigator)) return;

//         console.log("B")
//         const registration = await navigator.serviceWorker.ready;

//         // Limpeza de assinatura antiga para evitar o AbortError
//         const existingSub = await registration.pushManager.getSubscription();
//         if (existingSub) await existingSub.unsubscribe();
//         console.log("C")

//         const publicKey = 'BKU-RnXVzU2Ugxo7vk_Wh9dxY1fFE8A1M4cQEIMeDlY3dITozNxQrcA1uiuYvMSKxo4quovM-pD4sn5IIhpV71w'; // <--- COLOQUE A CHAVE GERADA AQUI
//         const convertedKey = urlBase64ToUint8Array(publicKey);

//         console.log("D")
//         const subscription = await registration.pushManager.subscribe({
//             userVisibleOnly: true,
//             applicationServerKey: convertedKey
//         });

//         console.log("E")
//         await fetch('/api/subscribe', {
//             method: 'POST',
//             body: JSON.stringify(subscription),
//             headers: { 'Content-Type': 'application/json' }
//         });

//         console.log("F")
//         console.log("✅ Agora sim! Navegador inscrito.");
//     } catch (err) {
//         console.error("❌ Erro fatal no Push:", err);
//     }
// }

// 3. CHAME A FUNÇÃO
initPush().catch(err => console.error(err));

let indCurrentDate = new Date();
indCurrentDate.setDate(1);
let indDataCache = [];

// Abrir Modal e preencher os dados atuais
function openEditInd(id) {
    const item = indDataCache.find(i => i._id === id);
    if (!item) return;

    document.getElementById('edit-ind-id').value = item._id;
    document.getElementById('edit-ind-desc').value = item.description;
    document.getElementById('edit-ind-value').value = item.value;
    document.getElementById('edit-ind-owner').value = item.owner;

    // NOVO: Preencher a categoria no modal
    document.getElementById('edit-ind-category').value = item.category || "Outros";

    // Ajusta a data
    const dateObj = new Date(item.date);
    document.getElementById('ind-date').value = dateObj.toISOString().split('T')[0];

    document.getElementById('edit-ind-date').value = dateObj.toISOString().split('T')[0];
    document.getElementById('modal-edit-ind').classList.remove('hidden');
}

// Salvar a edição com a categoria
async function saveIndEdit() {
    const id = document.getElementById('edit-ind-id').value;

    const payload = {
        description: document.getElementById('edit-ind-desc').value,
        value: parseFloat(document.getElementById('edit-ind-value').value),
        owner: document.getElementById('edit-ind-owner').value,
        category: document.getElementById('edit-ind-category').value, // PEGA A CATEGORIA EDITADA
        date: document.getElementById('edit-ind-date').value
    };

    try {
        const response = await fetch(`/api/individual/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            closeIndModal();
            showNotification("Gasto atualizado com sucesso!");
            loadIndividualData(); // Recarrega a tabela e os cards
        }
    } catch (err) {
        console.error("Erro ao editar:", err);
    }
}

function closeIndModal() {
    document.getElementById('modal-edit-ind').classList.add('hidden');
}

let disneyChart = null;
let allDisneyData = [];
async function loadDisneyData() {

    document.getElementById('disney-date').value = new Date().toISOString().split('T')[0];
    try {
        const res = await fetch(DISNEY_API_URL);
        allDisneyData = await res.json();
        filterDisneyDisplay(); // Chama a função que renderiza tabela e gráfico
    } catch (err) {
        console.error("Erro ao carregar dados Disney:", err);
    }
}
// Cores padrão do seu sistema para manter a identidade
const chartColors = ['#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#dbeafe'];

function filterDisneyDisplay() {
    const filter = document.getElementById('filter-disney-responsible').value;

    // Filtro dos dados
    const filteredData = filter === 'Todos'
        ? allDisneyData
        : allDisneyData.filter(item => item.responsible === filter);

    const categoryTotals = {};
    const userTotals = { "Kevin": 0, "Any": 0, "Conjunto": 0, "Maria Vitoria": 0 };
    let sumUSD = 0;
    let sumBRL = 0;
    let totalGeneralBRL = 0;

    // Tabela Principal de Gastos
    const tbody = document.querySelector('#disney-table tbody');
    tbody.innerHTML = '';

    filteredData.forEach(item => {
        // Acumular totais para os cards superiores
        if (item.originalCurrency === 'USD') sumUSD += item.originalValue;
        if (item.originalCurrency === 'BRL') sumBRL += item.originalValue;
        totalGeneralBRL += item.valueBRL;

        // Acumular categorias (usado para gráfico e tabela lateral)
        categoryTotals[item.category] = (categoryTotals[item.category] || 0) + item.valueBRL;

        // Acumular por usuário (usado para os cards de resumo por pessoa)
        if (userTotals.hasOwnProperty(item.responsible)) {
            userTotals[item.responsible] += item.valueBRL;
        }

        const row = tbody.insertRow();
        row.innerHTML = `
            <td class="p-4 text-gray-500">${new Date(item.date).toLocaleDateString('pt-BR')}</td>
            <td class="p-4 font-bold text-gray-800">${item.description}</td>
            <td class="p-4"><span class="text-blue-600 font-bold text-xs uppercase">${item.responsible}</span></td>
            <td class="p-4 text-xs text-gray-500 uppercase font-semibold">${item.category}</td>
            <td class="p-4 text-right font-mono text-green-600 font-bold">US$ ${item.valueUSD.toFixed(2)}</td>
            <td class="p-4 text-right font-mono text-blue-800 font-bold">R$ ${item.valueBRL.toFixed(2)}</td>
            <td class="p-4 text-center space-x-2">
                <button onclick="editDisneyExpense('${item._id}')" class="text-blue-500">✏️</button>
                <button onclick="deleteDisneyExpense('${item._id}')" class="text-red-500 font-bold">✕</button>
            </td>
        `;
    });

    // 1. Atualiza Cards de Totais
    document.getElementById('total-disney-only-usd').textContent = `US$ ${sumUSD.toFixed(2)}`;
    document.getElementById('total-disney-only-brl').textContent = `R$ ${sumBRL.toFixed(2)}`;
    document.getElementById('total-disney-general-brl').textContent = `R$ ${totalGeneralBRL.toFixed(2)}`;

    // 2. Atualiza Tabela Lateral de Categorias
    renderDisneyCategoryTable(categoryTotals);

    // 3. Atualiza Resumo por Usuário
    renderDisneyUserSummary(userTotals);

    // 4. Atualiza Gráfico de Pizza
    updateDisneyPieChart(categoryTotals);
}

function renderDisneyCategoryTable(totals) {
    const tbody = document.getElementById('disney-category-body');
    tbody.innerHTML = '';

    // Ordenar categorias do maior para o menor gasto
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);

    sorted.forEach(([cat, val]) => {
        const row = tbody.insertRow();
        row.innerHTML = `
            <td class="px-3 py-2 text-left font-medium text-gray-700">${cat}</td>
            <td class="px-3 py-2 text-right font-mono font-bold text-gray-900">R$ ${val.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
        `;
    });
}

function updateDisneyPieChart(totals) {
    const ctx = document.getElementById('disney-chart-canvas').getContext('2d');
    if (disneyChart) disneyChart.destroy();

    disneyChart = new Chart(ctx, {
        type: 'pie', // Alterado para Pizza
        data: {
            labels: Object.keys(totals),
            datasets: [{
                data: Object.values(totals),
                backgroundColor: ['#FBBF24', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 12, font: { size: 10 } }
                }
            }
        }
    });
}

function renderDisneyUserSummary(totals) {
    const container = document.getElementById('disney-user-summary');
    container.innerHTML = '';

    Object.entries(totals).forEach(([user, total]) => {
        const div = document.createElement('div');
        div.className = "flex justify-between items-center p-3 bg-gray-50 rounded-xl border border-gray-100";
        div.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-2 h-2 rounded-full bg-blue-600"></div>
                <span class="text-sm font-bold text-gray-700">${user}</span>
            </div>
            <div class="text-right">
                <p class="text-xs text-gray-400 uppercase font-bold">Total Gasto (R$)</p>
                <p class="text-sm font-mono font-bold text-blue-700">R$ ${total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
            </div>
        `;
        container.appendChild(div);
    });
}

// Salvar / Atualizar
document.getElementById('disney-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('disney-edit-id').value;
    const value = parseFloat(document.getElementById('disney-value').value);
    const currency = document.getElementById('disney-currency').value;

    const data = {
        date: document.getElementById('disney-date').value,
        description: document.getElementById('disney-desc').value,
        responsible: document.getElementById('disney-responsible').value,
        category: document.getElementById('disney-category').value,
        originalValue: value,
        originalCurrency: currency,
        valueUSD: currency === 'USD' ? value : value / COTACAO_FIXA,
        valueBRL: currency === 'BRL' ? value : value * COTACAO_FIXA
    };

    const method = id ? 'PUT' : 'POST';
    const url = id ? `${DISNEY_API_URL}/${id}` : DISNEY_API_URL;

    await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    cancelDisneyEdit();
    loadDisneyData();
});

// Função para abrir o modal e carregar os dados
async function editDisneyExpense(id) {
    const res = await fetch(DISNEY_API_URL);
    const items = await res.json();
    const item = items.find(i => i._id === id);

    if (item) {
        document.getElementById('modal-disney-id').value = item._id;
        document.getElementById('modal-disney-date').value = item.date.split('T')[0];
        document.getElementById('modal-disney-desc').value = item.description;
        document.getElementById('modal-disney-value').value = item.originalValue;
        document.getElementById('modal-disney-currency').value = item.originalCurrency;
        document.getElementById('modal-disney-responsible').value = item.responsible;
        document.getElementById('modal-disney-category').value = item.category;

        document.getElementById('disney-modal').classList.remove('hidden');
    }
}

// Fechar Modal
function closeDisneyModal() {
    document.getElementById('disney-modal').classList.add('hidden');
    document.getElementById('disney-modal-form').reset();
}

// Lógica de envio do FORMULÁRIO DO MODAL
document.getElementById('disney-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('modal-disney-id').value;
    const value = parseFloat(document.getElementById('modal-disney-value').value);
    const currency = document.getElementById('modal-disney-currency').value;

    const data = {
        date: document.getElementById('modal-disney-date').value,
        description: document.getElementById('modal-disney-desc').value,
        responsible: document.getElementById('modal-disney-responsible').value,
        category: document.getElementById('modal-disney-category').value,
        originalValue: value,
        originalCurrency: currency,
        valueUSD: currency === 'USD' ? value : value / COTACAO_FIXA,
        valueBRL: currency === 'BRL' ? value : value * COTACAO_FIXA
    };

    try {
        const response = await fetch(`${DISNEY_API_URL}/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (response.ok) {
            closeDisneyModal();
            loadDisneyData(); // Recarrega a tabela e os totais
            showNotification("Gasto atualizado com sucesso!");
        }
    } catch (err) {
        showNotification("Erro ao atualizar gasto.", true);
    }
});

function cancelDisneyEdit() {
    document.getElementById('disney-form').reset();
    document.getElementById('disney-edit-id').value = "";
    document.getElementById('disney-form-title').textContent = "Nova Compra Disney";
    document.getElementById('disney-submit-btn').textContent = "Salvar";
    document.getElementById('disney-submit-btn').classList.replace('bg-orange-500', 'bg-blue-600');
    document.getElementById('disney-cancel-btn').classList.add('hidden');
}

async function deleteDisneyExpense(id) {
    if (confirm("Deseja excluir este gasto da Disney?")) {
        await fetch(`${DISNEY_API_URL}/${id}`, { method: 'DELETE' });
        loadDisneyData();
    }
}

let consorcioChart = null;
// Função para alternar entre Gráfico e Tabela
function toggleConsorcioView(view) {
    const chartContainer = document.getElementById('consorcio-chart-container');
    const tableContainer = document.getElementById('consorcio-table-container');
    const btnChart = document.getElementById('btn-view-chart');
    const btnTable = document.getElementById('btn-view-table');

    if (view === 'chart') {
        chartContainer.classList.remove('hidden');
        tableContainer.classList.add('hidden');
        btnChart.className = "py-1 px-4 rounded-md text-xs font-bold transition-all bg-white shadow-sm text-blue-600";
        btnTable.className = "py-1 px-4 rounded-md text-xs font-bold transition-all text-gray-500";
    } else {
        chartContainer.classList.add('hidden');
        tableContainer.classList.remove('hidden');
        btnTable.className = "py-1 px-4 rounded-md text-xs font-bold transition-all bg-white shadow-sm text-blue-600";
        btnChart.className = "py-1 px-4 rounded-md text-xs font-bold transition-all text-gray-500";
    }
}
// 1. Quando mudar a % do Ágio, calcula o valor em R$ do Ágio
function atualizarAgioPorPercentual() {
    const elValorCarta = document.getElementById('cons-valor-carta');
    const elPercent = document.getElementById('cons-percent-venda');
    const elAgioRes = document.getElementById('cons-venda-agio');

    if (!elValorCarta || !elPercent || !elAgioRes) return;

    const valorCarta = parseFloat(elValorCarta.value) || 55042.60;
    const percent = parseFloat(elPercent.value) / 100;
    const novoAgio = valorCarta * percent;

    elAgioRes.value = novoAgio.toFixed(2);

    // Atualiza o label visual do %
    const label = document.getElementById('label-percent-venda');
    if (label) label.innerText = (percent * 100).toFixed(1) + "%";

    // Recalcula a comissão baseada no NOVO ágio e depois roda a simulação
    executarCalculosEmCadeia();
}

// 2. Quando mudar a % da Comissão, calcula o valor em R$ da Comissão
function atualizarComissaoPorPercentual() {
    const elAgio = document.getElementById('cons-venda-agio');
    const elPercentCom = document.getElementById('cons-percent-comissao');
    const elValorCom = document.getElementById('cons-valor-comissao');

    if (!elAgio || !elPercentCom || !elValorCom) return;

    const vendaAgio = parseFloat(elAgio.value) || 0;
    const percentComissao = parseFloat(elPercentCom.value) / 100;

    const valorComissao = vendaAgio * percentComissao;
    elValorCom.value = valorComissao.toFixed(2);

    // Roda a simulação
    calcularSimulacaoReal();
}

// 3. Função auxiliar para evitar o loop infinito
// Chamada quando o Ágio muda, pois a comissão depende do valor do ágio
function executarCalculosEmCadeia() {
    // Primeiro atualiza a comissão (valor R$) baseado no ágio atual
    const vendaAgio = parseFloat(document.getElementById('cons-venda-agio').value) || 0;
    const percentComissao = parseFloat(document.getElementById('cons-percent-comissao').value) / 100;
    const valorComissao = vendaAgio * percentComissao;

    document.getElementById('cons-valor-comissao').value = valorComissao.toFixed(2);

    // Depois roda a simulação final
    calcularSimulacaoReal();
}
// Ajuste na função principal para considerar o Valor Total
function calcularSimulacaoReal() {
    const mesContemplacao = parseInt(document.getElementById('cons-mes-contemplacao').value);
    const parcelaPre = parseFloat(document.getElementById('cons-parcela-pre').value);
    const parcelaPos = parseFloat(document.getElementById('cons-parcela-pos').value);
    const lance = parseFloat(document.getElementById('cons-lance').value);
    const vendaAgio = parseFloat(document.getElementById('cons-venda-agio').value);

    // Investimento Inicial (Lance + Parcelas até contemplar)
    // Se contemplou no mês 1, você pagou Lance + 1 Parcela Pré
    const custoAquisicao = lance + (mesContemplacao * parcelaPre);
    // NOVO: Valor da Comissão
    const valorComissao = parseFloat(document.getElementById('cons-valor-comissao').value) || 0;
    const tbody = document.getElementById('consorcio-table-body');
    tbody.innerHTML = '';

    let mesesLabels = [];
    let lucroPorMes = [];
    let lucroPorMes2 = [];

    for (let m = 0; m <= 24; m++) {
        // Custo acumulado das parcelas após a contemplação
        let custoManutencaoPos = m * parcelaPos;

        // TOTAL INVESTIDO ATÉ O MÊS ATUAL
        let totalInvestidoAcumulado = custoAquisicao + custoManutencaoPos;

        // LUCRO LÍQUIDO = Valor da Venda - Tudo o que saiu do bolso
        let lucroLiquido = vendaAgio - totalInvestidoAcumulado - valorComissao;

        let roi = (lucroLiquido / totalInvestidoAcumulado) * 100;

        mesesLabels.push(m === 0 ? "Venda Imediata" : `+${m} m`);
        lucroPorMes.push(lucroLiquido.toFixed(2));

        let lucroLiquido2 = vendaAgio - totalInvestidoAcumulado - valorComissao;
        lucroPorMes2.push(lucroLiquido2.toFixed(2));
        const corTexto = lucroLiquido >= 0 ? "text-green-600" : "text-red-600";

        const row = `
            <tr class="border-b border-gray-50">
                <td class="py-3 text-gray-500 font-medium">${m === 0 ? "Venda Imediata" : "Após " + m + " meses"}</td>
                <td class="py-3 text-right text-gray-900">R$ ${totalInvestidoAcumulado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                <td class="py-3 text-right text-gray-400">R$ ${custoManutencaoPos.toLocaleString('pt-BR')}</td>
                <td class="py-3 text-right ${corTexto} font-bold">R$ ${lucroLiquido.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                <td class="py-3 text-right ${corTexto}">${roi.toFixed(1)}%</td>
            </tr>
        `;
        tbody.innerHTML += row;
    }
    const lucroHoje = parseFloat(lucroPorMes2[0]);
    // Ponto de Equilíbrio (Break-even)
    const mesPrejuizo = lucroPorMes.findIndex(l => parseFloat(l) < 0);
    const alertaEl = document.getElementById('cons-alerta-tempo');

    if (mesPrejuizo !== -1) {
        alertaEl.innerText = `⚠️ Atenção: Se não vender em ${mesPrejuizo} meses após contemplar, você começa a perder dinheiro.`;
        alertaEl.className = "mt-2 text-sm font-bold text-red-600 bg-red-50 p-2 rounded";
    } else {
        alertaEl.innerText = `✅ Operação segura: O ágio cobre os custos por mais de 2 anos.`;
        alertaEl.className = "mt-2 text-sm font-bold text-green-600 bg-green-50 p-2 rounded";
    }
    // Atualiza os cards de resumo e o gráfico como antes
    document.getElementById('cons-invest-inicial').innerText = custoAquisicao.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('cons-feedback-lucro').innerText = lucroHoje.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    renderizarGraficoConsorcio(mesesLabels, lucroPorMes);
}
// Reutilizando a função de gráfico anterior com melhorias
function renderizarGraficoConsorcio(labels, dataLucro) {
    const ctx = document.getElementById('consorcioChart').getContext('2d');
    if (window.consorcioChartInstance) window.consorcioChartInstance.destroy();

    window.consorcioChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Lucro Líquido na Venda (R$)',
                data: dataLucro,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                fill: true,
                pointRadius: 5,
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: false,
                    grid: { color: '#e5e7eb' }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (context) => `Lucro se vender: R$ ${parseFloat(context.raw).toLocaleString('pt-BR')}`
                    }
                }
            }
        }
    });
}


function switchTab(tab) {
    const mainTab = document.getElementById('tab-main');
    const indTab = document.getElementById('tab-individual');
    const disneyTab = document.getElementById('tab-disney');
    const btnMain = document.getElementById('btn-tab-main');
    const btnInd = document.getElementById('btn-tab-individual');
    const disneyInd = document.getElementById('btn-tab-disney');
    const btnconsorc = document.getElementById('btn-tab-consorcio');
    const consorc = document.getElementById('tab-consorcio'); // ADICIONE ESTA LINHA

    // Classes para o botão ATIVO
    const activeClasses = ['bg-blue-600', 'text-white', 'shadow-md'];
    // Classes para o botão INATIVO
    const inactiveClasses = ['text-gray-500', 'hover:bg-gray-100'];

    if (tab === 'main') {
        // Exibir conteúdo
        mainTab.classList.remove('hidden');
        indTab.classList.add('hidden');
        disneyTab.classList.add('hidden');
        consorc.classList.add('hidden');

        // Estilizar botões
        btnMain.classList.add(...activeClasses);
        btnMain.classList.remove(...inactiveClasses);

        btnInd.classList.add(...inactiveClasses);
        btnInd.classList.remove(...activeClasses);

        disneyInd.classList.add(...inactiveClasses);
        disneyInd.classList.remove(...activeClasses);


        btnconsorc.classList.add(...inactiveClasses);
        btnconsorc.classList.remove(...activeClasses);

    } else if (tab === 'individual') {
        // Exibir conteúdo
        mainTab.classList.add('hidden');
        disneyTab.classList.add('hidden');
        indTab.classList.remove('hidden');
        consorc.classList.add('hidden');

        // Estilizar botões
        btnInd.classList.add(...activeClasses);
        btnInd.classList.remove(...inactiveClasses);

        btnMain.classList.add(...inactiveClasses);
        btnMain.classList.remove(...activeClasses);

        disneyInd.classList.add(...inactiveClasses);
        disneyInd.classList.remove(...activeClasses);


        btnconsorc.classList.add(...inactiveClasses);
        btnconsorc.classList.remove(...activeClasses);
        // Carrega os dados da aba individual
        if (typeof loadIndividualData === 'function') {
            loadIndividualData();
        }
    } else if (tab === 'disney') {
        // Exibir conteúdo
        mainTab.classList.add('hidden');
        indTab.classList.add('hidden');
        disneyTab.classList.remove('hidden');
        consorc.classList.add('hidden');

        // Estilizar botões
        btnInd.classList.add(...inactiveClasses);
        btnInd.classList.remove(...activeClasses);

        btnMain.classList.add(...inactiveClasses);
        btnMain.classList.remove(...activeClasses);

        disneyInd.classList.add(...activeClasses);
        disneyInd.classList.remove(...inactiveClasses);

        btnconsorc.classList.add(...inactiveClasses);
        btnconsorc.classList.remove(...activeClasses);
        loadDisneyData()
    } else if (tab === 'consorcio') {
        // Exibir conteúdo
        mainTab.classList.add('hidden');
        disneyTab.classList.add('hidden');
        indTab.classList.add('hidden');
        consorc.classList.remove('hidden');

        // Estilizar botões
        btnInd.classList.add(...inactiveClasses);
        btnInd.classList.remove(...activeClasses);

        btnMain.classList.add(...inactiveClasses);
        btnMain.classList.remove(...activeClasses);

        disneyInd.classList.add(...inactiveClasses);
        disneyInd.classList.remove(...activeClasses);


        btnconsorc.classList.add(...activeClasses);
        btnconsorc.classList.remove(...inactiveClasses);

        setTimeout(calcularSimulacaoReal, 100); // Timeout pequeno para o Chart.js ler o tamanho da div
    }
}

async function loadIndividualData() {
    const month = indCurrentDate.getMonth();
    const year = indCurrentDate.getFullYear();

    // Atualiza Display de Mês
    const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
    document.getElementById('ind-month-display').textContent = `${monthNames[month]} ${year}`;

    const response = await fetch(`/api/individual/list?month=${month}&year=${year}`);
    indDataCache = await response.json();
    renderIndividualTable();
}

let individualChart = null;

// Função para filtrar pelo botão "Conjunto"
function setOwnerFilter(owner) {
    document.getElementById('filter-owner').value = owner;
    loadIndividualData();
}

function renderIndividualPieChart(data) {
    const chartContainer = document.getElementById('individualChartContainer');
    chartContainer.innerHTML = '<canvas id="individual-chart-canvas"></canvas>';
    const ctx = document.getElementById('individual-chart-canvas').getContext('2d');

    if (individualChart) {
        individualChart.destroy();
    }

    if (data.length === 0) {
        chartContainer.innerHTML = '<p class="text-center text-gray-500 py-4">Nenhuma despesa para exibir no gráfico.</p>';
        return;
    }

    // Agrupar dados por categoria
    const categories = {};
    data.forEach(item => {
        const cat = item.category || 'Outros';
        categories[cat] = (categories[cat] || 0) + item.value;
    });

    const breakdownData = Object.entries(categories).map(([category, total]) => ({ category, total }));

    // Usar a mesma função de cores do seu app original
    const backgroundColors = typeof generateColors === 'function'
        ? generateColors(breakdownData.length)
        : ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#64748b'];

    individualChart = new Chart(ctx, {
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
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            let label = context.label || '';
                            if (context.parsed !== null) {
                                // Usa a mesma função de formatar moeda do seu app
                                label += ': ' + formatCurrency(context.parsed);
                            }
                            return label;
                        }
                    }
                }
            }
        }
    });

    // Renderiza a Tabela de Detalhes Lateral
    renderIndividualCategoryTable(breakdownData);
}

function renderIndividualCategoryTable(breakdownList) {
    const tbody = document.getElementById('individual-category-body');
    tbody.innerHTML = '';

    if (breakdownList.length > 0) {
        breakdownList.sort((a, b) => b.total - a.total).forEach(item => {
            const row = tbody.insertRow();
            const cellCat = row.insertCell(0);
            const cellTotal = row.insertCell(1);

            cellCat.textContent = item.category;
            cellCat.classList.add('px-3', 'py-2', 'text-sm', 'text-gray-700');

            cellTotal.textContent = formatCurrency(item.total);
            cellTotal.classList.add('px-3', 'py-2', 'text-right', 'text-sm', 'font-bold', 'text-gray-900');
        });
    } else {
        tbody.innerHTML = '<tr><td colspan="2" class="text-center py-4 text-gray-500">Nenhum gasto registrado.</td></tr>';
    }
}


// Atualize sua função principal de renderização para chamar a nova lógica
function renderIndividualTable() {
    document.getElementById('ind-date').value = new Date().toISOString().split('T')[0];
    const filter = document.getElementById('filter-owner').value;
    const tbody = document.getElementById('individual-table-body');
    const personCardsContainer = document.getElementById('individual-cards');

    tbody.innerHTML = '';

    // 1. Calcular Totais por Pessoa (Sempre do mês inteiro, independente do filtro)
    const personTotals = { Any: 0, Kevin: 0, Conjunto: 0 };
    indDataCache.forEach(item => {
        if (personTotals.hasOwnProperty(item.owner)) {
            personTotals[item.owner] += item.value;
        }
    });

    // 2. Renderizar os Cards de Pessoa (Any, Kevin, Conjunto)
    personCardsContainer.innerHTML = Object.entries(personTotals).map(([name, total]) => `
        <div class="summary-card bg-white border-blue-200">
            <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider">${name}</h3>
            <p class="text-xl font-black text-blue-600">${formatCurrency(total)}</p>
        </div>
    `).join('');

    // 3. Filtrar dados para o gráfico e extrato
    const filtered = filter === 'Todos' ? indDataCache : indDataCache.filter(i => i.owner === filter);

    // Atualiza Gráfico e Tabela de Categoria Lateral
    renderIndividualPieChart(filtered);

    // 4. Preencher o Extrato Detalhado (Tabela de baixo)
    filtered.forEach(item => {
        const dateStr = new Date(item.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
        tbody.innerHTML += `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-4 text-gray-500 text-sm">${dateStr}</td>
                <td class="p-4">
                    <div class="font-medium text-gray-700">${item.description}</div>
                    <div class="text-[10px] text-gray-400 uppercase">${item.category}</div>
                </td>
                <td class="p-4"><span class="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-[10px] font-bold">${item.owner}</span></td>
                <td class="p-4 text-right font-bold text-blue-600">${formatCurrency(item.value)}</td>
                <td class="p-4 text-center">
                    <div class="flex justify-center gap-2">
                        <button onclick="openEditInd('${item._id}')" class="text-blue-400 hover:text-blue-600">✏️</button>
                        <button onclick="deleteInd('${item._id}')" class="text-red-400 hover:text-red-600">🗑️</button>
                    </div>
                </td>
            </tr>
        `;
    });
}

let consorciosSalvos = [];

// Chama isso quando carregar a página ou mudar de aba
async function loadConsorciosList() {
    try {
        const res = await fetch('/api/consorcios');
        consorciosSalvos = await res.json();

        const select = document.getElementById('select-consorcio-ativo');
        select.innerHTML = '<option value="">-- Novo Simulador Livre --</option>';

        consorciosSalvos.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c._id;
            opt.textContent = c.name;
            select.appendChild(opt);
        });
    } catch (e) { console.error("Erro ao listar consórcios", e); }
}

function carregarConsorcioSelecionado() {
    const id = document.getElementById('select-consorcio-ativo').value;
    const btnDelete = document.getElementById('btn-delete-consorcio');
    const labelBtn = document.getElementById('label-btn-salvar-cons');
    const inputId = document.getElementById('cons-id-ativo');

    if (!id) {
        // --- MODO: NOVO SIMULADOR LIVRE ---
        inputId.value = "";
        btnDelete.classList.add('hidden');
        labelBtn.innerText = "Salvar Novo";

        // Limpa todos os inputs para valores padrão/zerados
        document.getElementById('cons-valor-carta').value = 0; // Valor padrão ou 0
        document.getElementById('cons-mes-contemplacao').value = 0;
        document.getElementById('cons-parcela-pre').value = 0;
        document.getElementById('cons-parcela-pos').value = 0;
        document.getElementById('cons-lance').value = 0;
        document.getElementById('cons-venda-agio').value = 0;
        document.getElementById('cons-percent-comissao').value = 0;
        document.getElementById('cons-valor-comissao').value = 0;

        // Atualiza os labels visuais (se houver)
        if (document.getElementById('label-percent-venda')) {
            document.getElementById('label-percent-venda').innerText = "40.0%";
        }

        // Recalcula para mostrar o gráfico zerado/vazio
        if (typeof calcularSimulacaoReal === "function") calcularSimulacaoReal();
        return;
    }

    // --- MODO: CARREGAR SALVO ---
    const c = consorciosSalvos.find(item => item._id === id);
    if (c) {
        inputId.value = c._id;
        document.getElementById('cons-valor-carta').value = c.valorCarta || 0;
        document.getElementById('cons-mes-contemplacao').value = c.mesContemplacao || 0;
        document.getElementById('cons-parcela-pre').value = c.parcelaPre || 0;
        document.getElementById('cons-parcela-pos').value = c.parcelaPos || 0;
        document.getElementById('cons-lance').value = c.lance || 0;
        document.getElementById('cons-venda-agio').value = c.vendaAgio || 0;
        document.getElementById('cons-percent-comissao').value = c.percentComissao || 0;
        document.getElementById('cons-valor-comissao').value = c.valorComissao || 0;

        btnDelete.classList.remove('hidden');
        labelBtn.innerText = "Atualizar Dados";

        if (typeof calcularSimulacaoReal === "function") calcularSimulacaoReal();
    }
}

async function salvarConsorcio() {
    const idExistente = document.getElementById('cons-id-ativo').value;
    let nome = "";

    if (!idExistente) {
        nome = prompt("Dê um nome para este novo projeto:");
        if (!nome) return;
    } else {
        const atual = consorciosSalvos.find(c => c._id === idExistente);
        nome = atual.name;
    }

    const data = {
        name: nome,
        valorCarta: parseFloat(document.getElementById('cons-valor-carta').value) || 0,
        mesContemplacao: parseInt(document.getElementById('cons-mes-contemplacao').value) || 0,
        parcelaPre: parseFloat(document.getElementById('cons-parcela-pre').value) || 0,
        parcelaPos: parseFloat(document.getElementById('cons-parcela-pos').value) || 0,
        lance: parseFloat(document.getElementById('cons-lance').value) || 0,
        vendaAgio: parseFloat(document.getElementById('cons-venda-agio').value) || 0,
        percentComissao: parseFloat(document.getElementById('cons-percent-comissao').value) || 0,
        valorComissao: parseFloat(document.getElementById('cons-valor-comissao').value) || 0
    };

    if (idExistente) data._id = idExistente;

    const response = await fetch('/api/consorcios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    if (response.ok) {
        showNotification(idExistente ? "Consórcio atualizado!" : "Consórcio salvo!");
        await loadConsorciosList();
        if (!idExistente) {
            // Se era novo, seleciona ele automaticamente após salvar
            const novo = await response.json();
            document.getElementById('select-consorcio-ativo').value = novo._id;
            carregarConsorcioSelecionado();
        }
    }
}

async function deletarConsorcioAtivo() {
    const id = document.getElementById('select-consorcio-ativo').value;
    if (!id || !confirm("Apagar este consórcio permanentemente?")) return;

    await fetch(`/api/consorcios/${id}`, { method: 'DELETE' });
    showNotification("Removido com sucesso.");
    document.getElementById('select-consorcio-ativo').value = "";
    carregarConsorcioSelecionado();
    loadConsorciosList();
}

function changeIndMonth(step) {
    indCurrentDate.setMonth(indCurrentDate.getMonth() + step);
    loadIndividualData();
}

async function deleteInd(id) {
    if (!confirm("Excluir?")) return;
    await fetch(`/api/individual/${id}`, { method: 'DELETE' });
    loadIndividualData();
}

// 2. Atualize o Listener do Formulário para enviar a data selecionada
document.getElementById('individual-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const inputDate = document.getElementById('ind-date').value;
    const description = document.getElementById('ind-desc').value;
    const totalValue = parseFloat(document.getElementById('ind-value').value);
    const category = document.getElementById('ind-category').value;
    const installments = parseInt(document.getElementById('ind-installments').value) || 1;

    // Pegar donos selecionados (Kevin, Any, Conjunto)
    const selectedOwners = Array.from(document.querySelectorAll('input[name="owner-opt"]:checked'))
        .map(cb => cb.value);

    if (selectedOwners.length === 0) {
        showNotification("Selecione pelo menos um dono.", true);
        return;
    }

    // Cálculo do valor por pessoa e por parcela
    const valuePerPerson = totalValue / selectedOwners.length;
    const valuePerInstallment = valuePerPerson / installments;

    try {
        const requests = [];

        // Loop para cada dono selecionado
        selectedOwners.forEach(owner => {
            // Loop para cada parcela
            for (let i = 0; i < installments; i++) {
                // const date = new Date(inputDate + "T12:00:00");
                // date.setMonth(date.getMonth() + i); // Soma os meses das parcelas
                
                const [year, month, day] = inputDate.split('-').map(Number);
                const date = new Date(Date.UTC(year, month - 1, day-1));
                // Adicionamos os meses das parcelas
                date.setUTCMonth(date.getUTCMonth() + i);
                const payload = {
                    description: installments > 1 ? `${description} (${i + 1}/${installments})` : description,
                    value: valuePerInstallment,
                    owner: owner,
                    category: category,
                    date: date.toISOString()
                };

                requests.push(
                    fetch('/api/individual', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    })
                );
            }
        });

        await Promise.all(requests);

        showNotification(installments > 1
            ? `Compra parcelada em ${installments}x salva com sucesso!`
            : "Gasto adicionado!");

        e.target.reset();

        // Reseta campos padrões
        document.getElementById('ind-date').value = new Date().toISOString().split('T')[0];
        document.getElementById('ind-installments').value = 1;
        document.querySelectorAll('input[name="owner-opt"]').forEach(cb => cb.checked = false);

        loadIndividualData();
    } catch (err) {
        console.error("Erro ao salvar:", err);
        showNotification("Erro ao processar parcelamento.", true);
    }
});

/**
 * Renderiza a lista detalhada de transações.
 */
function renderTransactionList(transactions) {
    const tbody = document.querySelector('#transaction-list-table tbody');
    tbody.innerHTML = '';

    if (transactions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-gray-500 py-4">Nenhuma transação encontrada para este mês.</td></tr>';
        return;
    }

    // Reinicia o saldo para o cálculo deste mês
    let saldoAcumulado = 0;

    transactions.forEach(t => {
        const row = tbody.insertRow();

        const date = new Date(t.date);
        const formattedDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(date);

        const isReceita = t.type === 'RECEITA';
        const valueClass = isReceita ? 'text-green-600' : 'text-red-600';
        const recurrentIcon = t.isRecurrent ? '⚡' : '';

        // Cálculo do saldo linha a linha
        if (isReceita) {
            saldoAcumulado += t.value;
        } else {
            saldoAcumulado -= t.value;
        }

        row.insertCell(0).textContent = formattedDate;
        row.insertCell(1).textContent = t.description;
        row.insertCell(2).textContent = t.category;
        row.insertCell(3).textContent = t.type;

        // Valor da Transação
        const valueCell = row.insertCell(4);
        valueCell.textContent = formatCurrency(t.value);
        valueCell.classList.add('text-right', 'font-bold', valueClass);

        // SALDO DO DIA (Coluna 5)
        const saldoCell = row.insertCell(5);
        saldoCell.textContent = formatCurrency(saldoAcumulado);
        saldoCell.classList.add('text-right', 'font-bold');
        // Azul para positivo, Laranja para negativo
        saldoCell.classList.add(saldoAcumulado >= 0 ? 'text-blue-600' : 'text-orange-600');

        row.insertCell(6).textContent = recurrentIcon;

        // Ações
        const actionsCell = row.insertCell(7);
        actionsCell.classList.add('text-center');

        const editBtn = document.createElement('button');
        editBtn.className = 'text-blue-600 hover:text-blue-800 font-semibold mr-3';
        editBtn.textContent = 'Editar';
        editBtn.onclick = () => openEditModal(t);

        actionsCell.appendChild(editBtn);
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
    switchTab('main');
    loadConsorciosList();
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

// Lógica para detectar atualização do PWA
let newWorker;

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').then(reg => {
        reg.addEventListener('updatefound', () => {
            newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    // Se o worker foi instalado e já existe um antigo controlando a página
                    showUpdateNotification();
                }
            });
        });
    });
}

function showUpdateNotification() {
    // Criar um elemento visual de aviso (usando o sistema de notificação que você já tem ou um novo)
    const updateDiv = document.createElement('div');
    updateDiv.className = "fixed bottom-4 left-4 right-4 bg-blue-600 text-white p-4 rounded-xl shadow-2xl z-[100] flex justify-between items-center animate-bounce";
    updateDiv.innerHTML = `
        <span class="text-sm font-bold">✨ Nova versão disponível!</span>
        <button onclick="window.location.reload()" class="bg-white text-blue-600 px-3 py-1 rounded-lg text-xs font-black uppercase">Atualizar</button>
    `;
    document.body.appendChild(updateDiv);
}