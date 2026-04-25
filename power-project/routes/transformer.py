from flask import Blueprint, jsonify
from db import get_db_connection

transformer_bp = Blueprint('transformer', __name__)


@transformer_bp.route('/transformers', methods=['GET'])
def get_transformers():
    db = get_db_connection()
    cursor = db.cursor(dictionary=True)
    cursor.execute('SELECT * FROM transformer')
    data = cursor.fetchall()
    cursor.close()
    db.close()
    return jsonify(data)
