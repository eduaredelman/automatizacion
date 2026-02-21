const success = (res, data = {}, message = 'OK', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
};

const error = (res, message = 'Internal Server Error', statusCode = 500, details = null) => {
  const payload = { success: false, message, timestamp: new Date().toISOString() };
  if (details && process.env.NODE_ENV !== 'production') payload.details = details;
  return res.status(statusCode).json(payload);
};

const paginated = (res, rows, total, page, limit) => {
  return res.status(200).json({
    success: true,
    data: rows,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / limit),
    },
    timestamp: new Date().toISOString(),
  });
};

module.exports = { success, error, paginated };
