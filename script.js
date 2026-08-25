// 마지막 업데이트 날짜를 자동으로 표시
document.getElementById('lastUpdated').textContent =
  new Date().toISOString().slice(0, 10);
